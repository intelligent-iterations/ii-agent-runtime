import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { createHubWorkflow, createIssueForm, packageSettings, validateHubManifest } from '../src/hub-files.js';
import { compileHubPolicy, hubImageSettings, hubLaunchSettings, hubPolicy } from '../src/hub-policy.js';
import { planHub } from '../src/hub-setup.js';
import { samplePolicy } from './policy-fixture.js';
import { parseBaseBranch, parseTargetRepository } from '../src/hub-issue-form.js';
import { CURRENT_LAYOUT as layout } from '../src/identity.js';

const manifest = validateHubManifest({ schemaVersion: 2, kind: 'software-factory-hub', organization: 'example',
  hub: { repository: 'example/software-factory', id: 5, branch: 'main' }, app: { id: 10, installationId: 20 } }, layout);

test('the hub workflow runs on hub issues, holds no concurrency group, and passes secrets only through environment', () => {
  const workflow = parse(createHubWorkflow({ layout, source: { repository: 'example/runtime', revision: 'a'.repeat(40), readSshKeySecret: 'SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY' },
    image: `ghcr.io/example/worker@sha256:${'b'.repeat(64)}`, registryLogin: true, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7 }));
  assert.equal(workflow.name, 'Software Factory');
  assert.deepEqual(workflow.on, { issues: { types: ['opened', 'reopened', 'labeled'] } });
  assert.equal(workflow.concurrency, undefined, 'a concurrency group would let GitHub cancel waiting requests');
  const job = workflow.jobs.agent;
  assert.equal(job.if, "${{ github.run_number <= 1000 && (github.event.action != 'labeled' || startsWith(github.event.label.name, 'agent')) }}");
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write', actions: 'read', deployments: 'write', packages: 'read' });
  for (const step of job.steps) if (step.run) assert.ok(!step.run.includes('${{'), `step "${step.name}" runs no interpolated expression`);
  const launch = job.steps.find((step: any) => step.id === 'launch');
  assert.deepEqual(Object.keys(launch.env).sort(), ['FACTORY_APP_PRIVATE_KEY', 'FACTORY_ARTIFACT_PARENT', 'FACTORY_CODEX_API_KEY', 'FACTORY_GITHUB_TOKEN', 'FACTORY_HUB_LAYOUT']);
  assert.deepEqual([launch.env.FACTORY_HUB_LAYOUT, launch.env.FACTORY_APP_PRIVATE_KEY], ['current', '${{ secrets.SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY }}']);
  assert.equal(launch.run, 'node example/software-factory/dist/actions-cli.js hub-launch');
  assert.throws(() => createHubWorkflow({ layout, source: { repository: 'example/runtime', revision: 'a'.repeat(40), readSshKeySecret: 'AGENT_FACTORY_RUNTIME_DEPLOY_KEY' },
    image: `ghcr.io/example/worker@sha256:${'b'.repeat(64)}`, registryLogin: true, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7 }), /Invalid hub workflow input/,
  'the runtime deploy key is read only from the layout\'s own secret');
  // Setup that fails before the launch step still answers the issue, naming the image fix when the pull failed.
  const reply = job.steps.at(-1);
  assert.equal(reply.if, "${{ failure() && steps.launch.outcome == 'skipped' }}");
  assert.equal(reply.env.FACTORY_PULL_OUTCOME, '${{ steps.pull.outcome }}');
  assert.equal(reply.env.FACTORY_PACKAGE_SETTINGS, 'https://github.com/orgs/example/packages/container/worker/settings');
  assert.match(reply.run, /gh issue comment "\$FACTORY_ISSUE" --repo "\$GITHUB_REPOSITORY"/);
  assert.equal(job.steps.find((step: any) => step.id === 'pull').env.FACTORY_PACKAGE_SETTINGS, 'https://github.com/orgs/example/packages/container/worker/settings');
});

test('package settings links point at the ghcr.io package, whatever its tag or digest', () => {
  assert.equal(packageSettings(`ghcr.io/example/software-factory-worker@sha256:${'a'.repeat(64)}`), 'https://github.com/orgs/example/packages/container/software-factory-worker/settings');
  assert.equal(packageSettings('ghcr.io/example/worker:codex-0.159.2'), 'https://github.com/orgs/example/packages/container/worker/settings');
  assert.equal(packageSettings('docker.io/library/node'), 'the package settings');
});

test('the issue form produces a body the hub reads back as the target repository', () => {
  const form = parse(createIssueForm('example'));
  assert.deepEqual(form.body.filter((field: any) => field.type !== 'markdown').map((field: any) => [field.id, field.attributes.label, field.validations.required]),
    [['repository', 'Repository', true], ['base', 'Pull request into', false], ['task', 'Task', true]]);
  // GitHub renders each form field as "### <label>" followed by the answer, or "_No response_" when left empty.
  const render = (base: string) => form.body.filter((field: any) => field.type !== 'markdown')
    .map((field: any) => `### ${field.attributes.label}\n\n${({ repository: 'sample-project', base, task: 'Add a README' } as any)[field.id]}`).join('\n\n');
  assert.equal(parseTargetRepository(render('dev'), 'example'), 'example/sample-project');
  assert.equal(parseBaseBranch(render('dev')), 'dev');
  assert.equal(parseBaseBranch(render('_No response_')), undefined);
});

test('the organization policy leaves out what the hub fills in, and compiles for any target with the hub bindings', () => {
  const policy = JSON.parse(hubPolicy(samplePolicy()));
  assert.deepEqual(policy.github, { additionalRepositories: [] });
  assert.equal(policy.harness.apiKeySecret, undefined);
  assert.deepEqual([policy.limits.maxConcurrent, policy.limits.maxWorkflowRunNumber], [3, 10000]);
  const compiled = compileHubPolicy(hubPolicy(samplePolicy()), manifest, 'example/sample-project').configuration;
  assert.deepEqual(compiled.source, { provider: 'github', repository: 'example/sample-project', appId: 10, installationId: 20,
    permissions: { contents: 'write' }, requireAppOwner: true, additionalRepositories: [] }, 'the agent can push its branch and nothing else');
  assert.deepEqual([compiled.environment.provider, compiled.limits.maxRunsPerSubject, compiled.limits.overheadMinutes, compiled.limits.computeMicrousdPerMinute], ['docker', 1, 5, 6000]);
  assert.equal(JSON.stringify(compiled).match(/maxWorkflow|artifacts|runner|retention/), null, 'settings only the hub uses never reach the runtime');
  assert.throws(() => validateHubManifest({ ...manifest, hub: { ...manifest.hub, repository: 'other/software-factory' } }, layout), /Invalid hub manifest/);
  // Anyone who can read the hub files issues, so weaker policies or extra grants would hand out write access.
  const weaker = (change: (policy: any) => void) => { const policy = JSON.parse(hubPolicy(samplePolicy())); change(policy); return JSON.stringify(policy); };
  for (const change of [(p: any) => { p.launchPolicy = { mode: 'any-author', allowPublicContributors: true }; }, (p: any) => { p.launchPolicy.minimumPermission = 'triage'; },
    (p: any) => { p.github.additionalRepositories = [{ repository: 'example/shared', permissions: { contents: 'read' } }]; }]) {
    assert.throws(() => compileHubPolicy(weaker(change), manifest, 'example/sample-project'), /hub policy/);
  }
});

test('policies written by earlier versions still compile, and an unknown setting is refused rather than ignored', () => {
  // The format of hubs onboarded before the runtime's configuration became provider-neutral.
  const earlier = { ...JSON.parse(hubPolicy(samplePolicy())), environment: { provider: 'github-actions', runner: 'ubuntu-latest', image: `example/agent@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 4096 },
    artifacts: { provider: 'github-actions', retentionDays: 7, maxBytes: 1048576 } };
  assert.equal(compileHubPolicy(JSON.stringify(earlier), manifest, 'example/sample-project').configuration.environment.provider, 'docker');
  assert.deepEqual(hubLaunchSettings(JSON.stringify(earlier)), { trigger: { startLimits: { maxRunNumber: 10000, maxAttempts: 1 } }, evidence: { retentionDays: 7, maxBytes: 1048576 } });
  for (const [path, change] of [['limits.maxConcurent', (p: any) => { p.limits.maxConcurent = 2; }], ['harness.apiKey', (p: any) => { p.harness.apiKey = 'x'; }],
    ['source', (p: any) => { p.source = {}; }]] as const) {
    const policy = JSON.parse(hubPolicy(samplePolicy())); change(policy);
    assert.throws(() => compileHubPolicy(JSON.stringify(policy), manifest, 'example/sample-project'), new RegExp(`Unknown hub policy setting: ${path.replace('.', '\\.')}`));
  }
  const elsewhere = { ...earlier, environment: { ...earlier.environment, runner: 'self-hosted' } };
  assert.throws(() => compileHubPolicy(JSON.stringify(elsewhere), manifest, 'example/sample-project'), /environment\.runner must be ubuntu-latest/);
});

test('a new hub plan writes the manifest, policy, issue form and workflow in the current layout once connected', () => {
  const connection = { schemaVersion: 2 as const, organization: 'example', phase: 'connected' as const, layout: 'current' as const,
    hub: { repository: 'example/software-factory', id: 5, branch: 'main' }, app: { id: 10, slug: 'software-factory-example', installationId: 20 } };
  const plan = planHub(connection, samplePolicy(), { repository: 'example/runtime', revision: 'c'.repeat(40), readSshKeySecret: 'SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY' }, { registryLogin: false });
  assert.deepEqual(Object.keys(plan.files).sort(), ['.github/ISSUE_TEMPLATE/agent-task.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/workflows/software-factory.yml',
    '.software-factory/hub.json', '.software-factory/policy.json']);
  assert.equal(plan.files['.github/ISSUE_TEMPLATE/config.yml'], 'blank_issues_enabled: false\n');
  assert.equal(JSON.parse(plan.files['.software-factory/hub.json']!).kind, 'software-factory-hub');
  const workflow = parse(plan.files['.github/workflows/software-factory.yml']!);
  const launch = workflow.jobs.agent.steps.find((step: any) => step.id === 'launch');
  assert.deepEqual([workflow.name, launch.env.FACTORY_HUB_LAYOUT, launch.env.FACTORY_APP_PRIVATE_KEY, workflow.jobs.agent.steps[0].with['ssh-key']],
    ['Software Factory', 'current', '${{ secrets.SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY }}', '${{ secrets.SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY }}']);
  assert.throws(() => planHub({ ...connection, phase: 'app-stored' }, samplePolicy(), { repository: 'example/runtime', revision: 'c'.repeat(40) }, { registryLogin: false }), /Connect GitHub first/);
});

test('a configured signer makes the hub verify the image build attestation before using it, from any registry', () => {
  const source = { repository: 'example/runtime', revision: 'a'.repeat(40) };
  const digest = `@sha256:${'b'.repeat(64)}`;
  const privateCopy = parse(createHubWorkflow({ layout, source, image: `ghcr.io/example/worker${digest}`, registryLogin: true, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7, signerRepository: 'vendor/software-factory' })).jobs.agent;
  const pull = privateCopy.steps.find((step: any) => step.id === 'pull');
  assert.equal(pull.name, 'Verify and pull private worker image');
  assert.equal(pull.env.FACTORY_IMAGE_SIGNER, 'vendor/software-factory');
  assert.ok(pull.run.indexOf('docker login') < pull.run.indexOf('gh attestation verify') && pull.run.indexOf('gh attestation verify') < pull.run.indexOf('docker pull'),
    'log in, verify, then pull');
  assert.match(pull.run, /gh attestation verify "oci:\/\/\$FACTORY_WORKER_IMAGE" --repo "\$FACTORY_IMAGE_SIGNER"/);
  assert.equal(privateCopy.permissions.attestations, 'read');
  const mirror = parse(createHubWorkflow({ layout, source, image: `registry.example.com/mirror/worker${digest}`, registryLogin: false, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7, signerRepository: 'vendor/software-factory' })).jobs.agent;
  const verify = mirror.steps.find((step: any) => step.id === 'pull');
  assert.equal(verify.name, 'Verify worker image');
  assert.ok(mirror.steps.indexOf(verify) < mirror.steps.findIndex((step: any) => step.id === 'launch'));
  const unsigned = parse(createHubWorkflow({ layout, source, image: `registry.example.com/mirror/worker${digest}`, registryLogin: false, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7 })).jobs.agent;
  assert.ok(!unsigned.steps.some((step: any) => String(step.run ?? '').includes('attestation')));
  assert.equal(unsigned.permissions.attestations, undefined);
  assert.throws(() => createHubWorkflow({ layout, source, image: 'registry.example.com/mirror/worker:latest', registryLogin: false, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7 }), /pinned by digest/);
  assert.throws(() => createHubWorkflow({ layout, source, image: `ghcr.io/example/worker${digest}`, registryLogin: true, timeoutMinutes: 15, maxRunNumber: 1000, retentionDays: 7, signerRepository: 'not a repo' }), /signer/);
});

test('image verification is a hub setting: kept in the policy file, validated, and removed before compiling the agent policy', () => {
  const policy = { ...JSON.parse(hubPolicy(samplePolicy())), imageVerification: { signerRepository: 'vendor/software-factory' } };
  assert.deepEqual(hubImageSettings(policy), { image: policy.environment.image, signerRepository: 'vendor/software-factory' });
  assert.equal(compileHubPolicy(JSON.stringify(policy), manifest, 'example/sample-project').configuration.harness.model, 'gpt-6-astra');
  assert.throws(() => compileHubPolicy(JSON.stringify({ ...policy, imageVerification: { signerRepository: '../x' } }), manifest, 'example/sample-project'), /OWNER\/REPOSITORY/);
  const connection = { schemaVersion: 2 as const, organization: 'example', phase: 'connected' as const, layout: 'current' as const,
    hub: { repository: 'example/software-factory', id: 5, branch: 'main' }, app: { id: 10, slug: 'software-factory-example', installationId: 20 } };
  const plan = planHub(connection, samplePolicy(), { repository: 'example/runtime', revision: 'c'.repeat(40) }, { registryLogin: false, policy: JSON.stringify(policy) });
  assert.match(plan.files['.github/workflows/software-factory.yml']!, /gh attestation verify/);
});

test('the default policy names no worker image: each organization passes its own', async () => {
  const { defaultPolicy } = await import('../src/defaults.js');
  assert.equal((defaultPolicy() as any).environment.image, undefined);
  assert.doesNotMatch(JSON.stringify(defaultPolicy()), /intelligent-iterations/);
});
