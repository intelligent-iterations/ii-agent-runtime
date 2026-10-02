import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hubLaunchIdentity, launchFromHub } from '../src/hub-launch.js';
import { type PipelineServices } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { finishedMessage } from '../src/hub-messages.js';
import { hubPolicy } from '../src/hub-policy.js';
import { samplePolicy } from './policy-fixture.js';
import { digest } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { GitHubError, type GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { hubLayout, type HubLayoutName } from '../src/identity.js';

const policy = hubPolicy(samplePolicy());
// Each layout's durable names, written out: a hub made under the earlier name must keep every one of them.
const layouts = {
  current: { hub: 'example/software-factory', folder: '.software-factory', kind: 'software-factory-hub', prefix: 'software-factory', email: 'software-factory@users.noreply.github.com' },
  legacy: { hub: 'example/agent-factory', folder: '.agent-factory', kind: 'agent-factory-hub', prefix: 'agent-factory', email: 'agent-factory@users.noreply.github.com' },
};
const faults = ['none', 'no-push', 'no-pr-permission', 'missing-base', 'no-target', 'other-label', 'not-installed', 'authorization', 'admission', 'provision', 'second-authorization', 'execution', 'revocation'];

test('hub launch refuses anything but a hub issue event on a GitHub-hosted runner', () => {
  assert.throws(() => hubLaunchIdentity({}), /GitHub-hosted/);
  assert.throws(() => hubLaunchIdentity({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com' }), /hub workflow/);
});

test('hub launch refuses a layout its workflow cannot have named, before reading anything', async () => {
  const base: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'issues',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: 'example/software-factory',
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_REPOSITORY_ID: '5', GITHUB_RUN_ID: '70', GITHUB_RUN_ATTEMPT: '1' };
  const services: Partial<PipelineServices> = { createGitHubApi: () => { throw Error('no request may be made'); } };
  for (const [value, message] of [['next', /Unknown hub layout "next"; expected current or legacy/], ['Legacy', /Unknown hub layout/], ['', /Missing FACTORY_HUB_LAYOUT/],
    [undefined, /Missing FACTORY_HUB_LAYOUT/]] as const) {
    const env = { ...base, FACTORY_GITHUB_TOKEN: 'synthetic-actions-key', ...(value === undefined ? {} : { FACTORY_HUB_LAYOUT: value }) };
    await assert.rejects(launchFromHub(env, services), message, String(value));
  }
  assert.throws(() => hubLayout('agent-factory'), /Unknown hub layout/);
});

test('hub launch replies on the issue, verifies with a read-only token, reserves, runs and cleans up at every outcome, in either layout', async t => {
  // Every outcome in the current layout; a hub made under the earlier name launches with all of its own durable names.
  const cases: Array<[string, HubLayoutName]> = [...faults.map(fault => [fault, 'current'] as [string, HubLayoutName]), ['none', 'legacy'], ['admission', 'legacy']];
  for (const [fault, layoutName] of cases) {
    const names = layouts[layoutName];
    const manifest = { schemaVersion: 2, kind: names.kind, organization: 'example', hub: { repository: names.hub, id: 5, branch: 'main' }, app: { id: 100, installationId: 200 } };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-hub-launch-')));
    const owner = randomUUID();
    writeFileSync(join(root, '.owner'), owner, { flag: 'wx' });
    t.after(() => { assert.equal(readFileSync(join(root, '.owner'), 'utf8'), owner); rmSync(root, { recursive: true }); });
    writeFileSync(join(root, 'output'), '');
    const body = fault === 'no-target' ? 'Please fix sample-project' : '### Repository\n\nsample-project\n\n### Task\n\nAdd a README';
    writeFileSync(join(root, 'event.json'), JSON.stringify({ action: fault === 'other-label' ? 'labeled' : 'opened', label: { name: 'bug' },
      issue: { number: 3, body }, repository: { id: 5, full_name: names.hub } }));
    const env: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'issues',
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: names.hub.replace('example/', 'Example/'), FACTORY_HUB_LAYOUT: layoutName,
      GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_REPOSITORY_ID: '5', GITHUB_RUN_ID: '70', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_PATH: join(root, 'event.json'),
      FACTORY_GITHUB_TOKEN: 'synthetic-actions-key', FACTORY_APP_PRIVATE_KEY: 'synthetic-pem', FACTORY_CODEX_API_KEY: 'synthetic-model-key',
      RUNNER_TEMP: root, FACTORY_ARTIFACT_PARENT: join(root, 'software-factory-artifacts'), GITHUB_OUTPUT: join(root, 'output'), PATH: '/usr/bin:/bin' };
    const calls: string[] = [];
    const comments: string[] = [];
    const file = (content: string) => ({ status: 200, requestId: null, body: { encoding: 'base64', content: Buffer.from(content).toString('base64') } });
    const hubApi: GitHubApi = { requests: 0, async request(method, path, requestBody) {
      if (method === 'POST' && path === `/repos/${names.hub}/issues/3/comments`) { comments.push(String((requestBody as any).body)); return { status: 201, requestId: null, body: {} }; }
      // The hub's files are read only from the folder of the layout its workflow names.
      if (path.startsWith(`/repos/${names.hub}/contents/${names.folder}/hub.json?`)) return file(JSON.stringify(manifest));
      if (path.startsWith(`/repos/${names.hub}/contents/${names.folder}/policy.json?`)) return file(policy);
      if (path === `/repos/${names.hub}/commits/main`) return { status: 200, requestId: null, body: { sha: 'b'.repeat(40) } };
      throw Error(`Unexpected hub request ${method} ${path}`);
    } };
    let authorizations = 0;
    const pulls: Array<Record<string, unknown>> = [];
    const services: Partial<PipelineServices> = {
      createGitHubApi: options => options.credential() === 'synthetic-actions-key' ? hubApi : { requests: 0, async request(method, path, requestBody) {
        // The run's own tokens check what reached GitHub after the agent finishes; only the hub's pull request token opens one.
        if (method === 'POST' && path === '/repos/example/sample-project/pulls') {
          assert.equal(options.credential(), 'synthetic-pull-key', 'the pull request is opened with the hub-only token');
          pulls.push(requestBody as Record<string, unknown>);
          return { status: 201, requestId: null, body: { number: 7, html_url: 'https://github.com/example/sample-project/pull/7' } };
        }
        assert.equal(method, 'GET');
        if (path === '/repos/example/sample-project/branches/dev') return { status: 404, requestId: null, body: {} };
        if (path === `/repos/example/sample-project/branches/${names.prefix}/issue-3-run-70`) return fault === 'no-push' ? { status: 404, requestId: null, body: {} } : { status: 200, requestId: null, body: {} };
        if (path === `/repos/example/sample-project/compare/main...${names.prefix}%2Fissue-3-run-70`) return { status: 200, requestId: null, body: { ahead_by: 2, files: [{}, {}, {}] } };
        throw Error(`Unexpected target request ${path}`);
      } },
      authorizeIssueTask: async ({ run: identity, repository: target, compiled, options, consumer }) => {
        authorizations++; calls.push('authorize');
        assert.deepEqual(consumer, { name: names.prefix, displayName: 'Software Factory' }, 'runs are accepted only from the layout\'s workflow');
        assert.deepEqual([identity.repository, target, compiled.configuration.source.repository], [names.hub, 'example/sample-project', 'example/sample-project']);
        assert.deepEqual(options, { startLimits: { maxRunNumber: 10000, maxAttempts: 1 } }, 'the hub policy sets how many hub runs may start');
        assert.match(compiled.configuration.instructions, /Do not open pull requests or create issues yourself\.$/, 'the Factory tells its agents who opens the pull request');
        const allowed = fault !== 'authorization' && !(fault === 'second-authorization' && authorizations === 2);
        return { decision: { allowed, reason: allowed ? 'authorized' : 'author-denied', evidenceDigest: digest('evidence'), policyDigest: compiled.setupDigest, runId: '70', subjectId: 'issue:300' },
          evidence: { resource: 'repository:101', subjectId: 'issue:300', authorId: 'user:4', actorId: 'user:4', actorCapabilities: ['repository:write'],
            event: 'submitted', currentLabels: [], originalInputDigest: digest('input'), currentInputDigest: digest('input'),
            policyDigest: compiled.setupDigest, currentPolicyDigest: compiled.setupDigest, observedAt: Date.now(), open: true, runId: '70', attempt: 1 },
          targetId: 101, base: fault === 'missing-base' ? 'dev' : 'main', defaultBranch: 'main', task: { reference: 'issue-3', label: 'Issue #3', title: '[agent] Add a README', body } };
      },
      githubOrderedAdmissionStore: (_api, identity, consumer) => {
        assert.equal(identity.repository, names.hub);
        assert.deepEqual(consumer, { name: names.prefix, displayName: 'Software Factory' }, 'the layout\'s admission ledger keeps its name');
        return { append: async () => 1, read: async () => [], settle: async () => {} }; },
      reserveInvocationOrdered: async (_store, _limits, input, now) => {
        calls.push('reserve');
        assert.equal(input.resource, names.hub, 'one organization-wide budget');
        return fault === 'admission' ? { allowed: false, reason: 'concurrency-limit' } : { allowed: true, reservationDigest: digest('reservation'),
          reservation: { ...input, schemaVersion: 1, createdAt: now, expiresAt: now + 60000, reservedMicrousd: 1000 } };
      },
      openTofuWorker: options => ({ provision: async () => {
        calls.push('provision'); if (fault === 'provision') throw Error('Synthetic provider failure');
        return { owner: 'a'.repeat(32), containerId: 'c'.repeat(64), networkId: 'd'.repeat(64), directory: options.parent };
      }, close: async () => { calls.push('close-provisioner'); } }),
      createInstallationIssuer: () => ({ issue: async (repository, permissions) => {
        if (fault === 'not-installed') throw new GitHubError('ISSUANCE', 422);
        calls.push(`mint:${repository}:${Object.entries(permissions).map(([name, level]) => `${name}=${level}`).join(',')}`);
        if (permissions.pull_requests) assert.deepEqual(permissions, { contents: 'read', pull_requests: 'write' }, 'GitHub needs contents read to compare the refs');
        if (permissions.pull_requests && fault === 'no-pr-permission') throw new GitHubError('ISSUANCE', 422);
        return { repository, permissions, repositoryId: 101, token: permissions.pull_requests ? 'synthetic-pull-key' : 'synthetic-installation-key', expiresAt: new Date(Date.now() + 3600000).toISOString() };
      }, revoke: async () => { calls.push('revoke-reader'); }, verifyInstallation: async () => {},
      close: async () => { calls.push('close-tokens'); if (fault === 'revocation') throw Error('Synthetic revocation failure'); } }),
      isolateWorkerNetwork: async () => ({ address: '127.0.0.1', connect: async () => { calls.push('connect'); }, close: async () => { calls.push('close-network'); } }),
      openWorkerGateway: async () => ({ endpoint: 'http://127.0.0.1:12345', port: 12345, token: 'f'.repeat(64),
        snapshot: () => ({ requests: 0, transferredBytes: 0 }), close: async () => { calls.push('close-gateway'); } }),
      cloneRepository: async input => {
        calls.push(`checkout:${input.base}`);
        assert.equal(input.token, 'synthetic-installation-key', 'the checkout reads with the read-only token');
        mkdirSync(join(input.directory, 'repository'));
        writeFileSync(join(input.directory, 'repository', 'package-lock.json'), '{}');
        return join(input.directory, 'repository');
      },
      loadWorkerSource: async () => { calls.push('load'); },
      runWorkerSetup: async (_worker, commands) => { calls.push(`setup:${commands.join(';')}`); return { exitCode: 0, seconds: 12, timedOut: false }; },
      executeCodexWorker: async input => {
        calls.push('execute'); if (fault === 'execution') throw Error('Synthetic worker failure');
        assert.deepEqual(input.setup, { label: 'npm ci', exitCode: 0, seconds: 12, timedOut: false }, 'the agent is told what was installed');
        assert.ok(!JSON.stringify(input).includes('synthetic-pem') && !JSON.stringify(input).includes('synthetic-model-key'));
        assert.deepEqual([input.branch, input.task.label, input.delivered, input.author.email, input.author.name],
          [`${names.prefix}/issue-3-run-70`, 'Issue #3', true, names.email, 'Software Factory'], 'the branch prefix and author address keep the layout\'s name');
        return { exitCode: 0, head: 'e'.repeat(40), dirty: false, branch: input.branch };
      },
    };
    const failing = ['provision', 'second-authorization', 'execution', 'revocation'].includes(fault);
    if (failing) await assert.rejects(launchFromHub(env, services), /inspect the bounded run evidence/, fault);
    else await launchFromHub(env, services);
    assert.equal(env.FACTORY_APP_PRIVATE_KEY, undefined);
    if (fault === 'no-target') { assert.deepEqual(calls, []); assert.match(comments[0]!, /Name the repository to change/); continue; }
    if (fault === 'other-label') { assert.deepEqual([calls, comments], [[], []], 'an unrelated label is ignored silently'); continue; }
    const output = readFileSync(join(root, 'output'), 'utf8').trim();
    const raw = readFileSync(join(output.slice('artifact_directory='.length), 'run.json'), 'utf8');
    assert.ok(!raw.includes('synthetic-pem') && !raw.includes('synthetic-model-key') && !raw.includes('synthetic-installation-key'));
    const report = JSON.parse(raw);
    assert.equal(report.repository, 'example/sample-project');
    if (fault === 'not-installed') { assert.equal(report.status, 'denied'); assert.match(comments[0]!, /cannot access `example\/sample-project`/); continue; }
    assert.equal(calls[0], 'mint:example/sample-project:contents=read', 'verification uses a token that cannot write');
    if (fault === 'authorization') { assert.match(comments.join('\n'), /You need write access to `example\/sample-project`/); assert.ok(!calls.includes('reserve')); }
    if (fault === 'admission') { assert.match(comments.join('\n'), /3 agents are already running/); assert.ok(!calls.includes('provision')); }
    if (fault === 'none') {
      assert.deepEqual(calls.slice(1, 8), ['authorize', 'reserve', 'provision', 'checkout:main', 'load', 'setup:npm ci --no-audit --no-fund',
        'mint:example/sample-project:contents=write'], 'dependencies install with internet access before any write credential exists; the agent can only push');
      assert.deepEqual(report.setup, { label: 'npm ci', exitCode: 0, seconds: 12, timedOut: false });
      assert.match(comments[0]!, /Starting an agent on `example\/sample-project`/);
      assert.equal(comments[1], 'The agent opened [pull request #7](https://github.com/example/sample-project/pull/7) into `main` in `example/sample-project`: 2 commits changing 3 files. ' +
        `[Run details](https://github.com/${names.hub}/actions/runs/70)`);
      assert.deepEqual(report.push, { verified: true, branch: `${names.prefix}/issue-3-run-70`, base: 'main', commits: 2, files: 3 });
      assert.deepEqual(report.changeRequest, { number: 7, url: 'https://github.com/example/sample-project/pull/7' });
      assert.deepEqual([pulls[0]!.title, pulls[0]!.head, pulls[0]!.base], ['Add a README', `${names.prefix}/issue-3-run-70`, 'main']);
      assert.ok(String(pulls[0]!.body).startsWith(`Opened by Software Factory for [${names.hub}#3](https://github.com/${names.hub}/issues/3).`), String(pulls[0]!.body));
    }
    if (fault === 'no-pr-permission') {
      assert.equal(pulls.length, 0);
      assert.match(comments[1]!, /pushed 2 commits changing 3 files.*\[Open the pull request into `main`\]\(https:\/\/github.com\/example\/sample-project\/compare\/main\.\.\.software-factory\/issue-3-run-70\?expand=1\).*lacks the \*\*Pull requests\*\* permission/);
    }
    if (fault === 'missing-base') {
      assert.match(comments[0]!, /has no branch named `dev`/);
      assert.ok(!calls.includes('reserve') && !calls.includes('provision'), 'a missing base stops before any spend');
    }
    if (fault === 'no-push') assert.match(comments[1]!, /finished without pushing any changes to `example\/sample-project`/, 'a run that pushed nothing never claims a branch');
    if (fault === 'second-authorization') assert.ok(!calls.includes('execute') && !calls.includes('revoke-reader'));
    if (['provision', 'execution'].includes(fault)) assert.match(comments.at(-1)!, /did not complete/);
    if (fault === 'authorization' || fault === 'admission') assert.equal(comments.length, 1, 'one reply per refusal');
    if (['none', 'second-authorization', 'execution', 'revocation'].includes(fault)) assert.deepEqual(calls.slice(-4), ['close-gateway', 'close-network', 'close-tokens', 'close-provisioner']);
    assert.equal(report.status, ['none', 'no-push', 'no-pr-permission'].includes(fault) ? 'worker-completed' : ['authorization', 'admission', 'missing-base'].includes(fault) ? 'denied' : fault === 'revocation' ? 'cleanup-unconfirmed' : 'failed', fault);
  }
});

test('a refused pull request is explained with GitHub\'s status and reason', () => {
  assert.match(finishedMessage('example/sample-project', { status: 'worker-completed', push: { verified: true, branch: 'b', base: 'main', commits: 1, files: 1 },
    changeRequestError: 'refused', changeRequestRefusal: { status: 403, reason: 'Resource not accessible by integration' } }, 'https://run'),
  /GitHub refused to open it automatically \(HTTP 403: Resource not accessible by integration\)\./);
});
