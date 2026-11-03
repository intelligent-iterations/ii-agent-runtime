import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubPermissionPreflight, type GitHubRepositoryEvidence, type WorkflowIdentityAssessors, type WorkflowIdentityAssessor,
  type WorkflowIdentityRequest } from '../../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../../src/providers/tools/github.js';
import { gcpWorkflowServiceAccountAssessor } from '../../../src/providers/tools/cloud-evidence.js';
import { gcpGithubWorkloadIdentityTrust, gcpServiceAccountProject } from '../../../src/providers/tools/gcp-service-account-authority.js';
import { resolveWorkflowValue } from '../../../src/providers/tools/workflow-values.js';
import { createGrant, createToolSession, defineTool } from '../../../src/runtime/tools.js';
import { preflightTools } from '../../../src/runtime/preflight.js';

const account = 'functions-deployer@acme-prod.iam.gserviceaccount.com';
const provider = 'projects/123456789/locations/global/workloadIdentityPools/github/providers/github';
const deploy = (auth: string, options: { env?: string; on?: string } = {}) => `on:
${options.on ?? '  push: {branches: [main]}'}
permissions: {contents: read}
jobs:
  deploy:
    permissions: {id-token: write, contents: read}
${options.env ?? ''}    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: google-github-actions/auth@v2
        with:
${auth}
      - run: ./scripts/deploy.sh
`;
const wif = (sa: string, wip = provider) => `          workload_identity_provider: ${wip}\n          service_account: ${sa}`;
async function execution(paths: string[], workflow: string, identity?: WorkflowIdentityAssessors) {
  const subject = 'agent:coder';
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: 'acme/app', key: 'test', assignment: subject } });
  const tools = createToolSession({ subject, tools: [tool],
    grants: [createGrant({ subject, tool, resources: { repository: ['acme/app'], branch: ['main'], path: paths } })],
    context: { executionId: 'test', attemptId: 'test', inputDigest: 'sha256:test', deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
    resolveCredential: async () => { throw Error('Preflight must not resolve the agent credential'); } });
  const collect = async (repository: string, branch: string): Promise<GitHubRepositoryEvidence> => ({ repository, branch, actionsEnabled: true,
    complete: true, source: 'github:fixture', observedAt: Date.now(), workflows: [{ path: '.github/workflows/deploy.yml', content: workflow }] });
  const report = await preflightTools(tools, { signal: new AbortController().signal,
    inspectors: [githubPermissionPreflight(collect, identity ? { workflowIdentity: identity } : {})] });
  return report.checks.find(item => item.id === 'github.workflow-execution')!;
}
function recorder(requests: WorkflowIdentityRequest[]): WorkflowIdentityAssessor {
  return async request => {
    requests.push(request);
    return { identity: request.identity, trust: 'admits', evidence: [{ source: 'gcp:fixture', resource: request.identity, observedAt: Date.now() }],
      potentialAuthority: [{ provider: 'gcp', operation: 'cloudfunctions.functions.update', resources: { project: ['acme-prod'] } }],
      declaredAuthority: [{ provider: 'gcp', operation: 'roles/cloudfunctions.developer', resources: { project: ['acme-prod'] } }],
      limitations: ['fixture limitation'] };
  };
}

test('workflow expressions resolve to every value a run on the branch can produce', () => {
  const on = { push: null, workflow_dispatch: { inputs: { project: { type: 'choice', options: ['acme-dev', 'acme-prod'] } } } };
  const env = { PROJECT: "${{ inputs.project || (github.ref == 'refs/heads/main' && 'acme-prod' || 'acme-dev') }}" };
  const context = (branch: string, events: unknown = on) => ({ branch, env: [{}, env], on: events });
  assert.deepEqual(resolveWorkflowValue('sa@${{ env.PROJECT }}.iam.gserviceaccount.com', context('main', { push: null })),
    { values: ['sa@acme-prod.iam.gserviceaccount.com'] });
  assert.deepEqual(resolveWorkflowValue('sa@${{ env.PROJECT }}.iam.gserviceaccount.com', context('feature', { push: null })),
    { values: ['sa@acme-dev.iam.gserviceaccount.com'] });
  const both = resolveWorkflowValue('${{ env.PROJECT }}', context('main'));
  assert.ok('values' in both);
  assert.deepEqual(both.values.sort(), ['acme-dev', 'acme-prod']);
  assert.deepEqual(resolveWorkflowValue("${{ 'a' || secrets.X }}", context('main')), { values: ['a'] });
  assert.deepEqual(resolveWorkflowValue("${{ github.ref_name == 'MAIN' }}", context('main')), { values: ['true'] });
  for (const [value, reason] of [['${{ secrets.SA }}', 'secrets.SA'], ['${{ vars.SA }}', 'vars.SA'], ['${{ env.LATER }}', 'env.LATER'],
    ["${{ format('{0}', 'x') }}", 'unsupported'], ['${{ inputs.free }}', 'inputs.free']] as const) {
    const resolved = resolveWorkflowValue(value, context('main', { workflow_dispatch: { inputs: { free: { type: 'string' } } } }));
    assert.ok('unresolved' in resolved && resolved.unresolved.includes(reason), `${value}: ${JSON.stringify(resolved)}`);
  }
  assert.ok('unresolved' in resolveWorkflowValue('${{ inputs.x }}', context('main', { workflow_call: null })));
});

test('workload identity federation joins the job to a resolved service account', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const check = await execution(['scripts/deploy.sh'], deploy(wif(account)), { gcp: recorder(requests) });
  assert.equal(check.status, 'finding');
  assert.ok(check.summary.includes(`requests ${account}`));
  assert.deepEqual(requests, [{ provider: 'gcp', identity: account, repository: 'acme/app', branch: 'main', federation: provider,
    workflow: 'acme/app@main:.github/workflows/deploy.yml#deploy', oidc: true, oidcSubject: 'repo:acme/app:ref:refs/heads/main' }]);
  assert.deepEqual(check.path, [
    'contents.write acme/app@main:scripts/deploy.sh',
    'acme/app@main:.github/workflows/deploy.yml#deploy',
    `assumes gcp ${account} via OIDC through ${provider}`,
    'service account bindings admit repo:acme/app:ref:refs/heads/main',
    'gcp:cloudfunctions.functions.update acme-prod (provider-evaluated allow)',
    'gcp:roles/cloudfunctions.developer acme-prod (declared in policy, not provider-evaluated)',
  ]);
});

test('an env-composed service account resolves to each project a dispatch can choose', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const env = "    env:\n      PROJECT: ${{ inputs.project || (github.ref == 'refs/heads/main' && 'acme-prod' || 'acme-dev') }}\n";
  const on = '  push: {branches: [main]}\n  workflow_dispatch:\n    inputs:\n      project: {type: choice, options: [acme-dev, acme-prod]}';
  const check = await execution(['package.json'], deploy(wif('functions-deployer@${{ env.PROJECT }}.iam.gserviceaccount.com',
    'projects/${{ env.PROJECT_NUMBER }}/locations/global/workloadIdentityPools/github/providers/github'), { env, on }), recorder(requests));
  assert.equal(check.status, 'finding');
  assert.deepEqual(requests.map(item => item.identity).sort(),
    ['functions-deployer@acme-dev.iam.gserviceaccount.com', 'functions-deployer@acme-prod.iam.gserviceaccount.com']);
  assert.ok(requests.every(item => item.federation === undefined));
  assert.ok(check.limitations.some(item => item.includes('can request 2 gcp identities on refs/heads/main')));
});

test('secret-held identities and stored keys stay unresolved and are never assessed', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const secret = await execution(['scripts/deploy.sh'], deploy(wif('${{ secrets.GCP_SA_EMAIL }}', '${{ secrets.GCP_WIF }}')), recorder(requests));
  assert.equal(secret.status, 'finding');
  assert.ok(secret.path.includes('requests gcp credentials from service_account ${{ secrets.GCP_SA_EMAIL }} (unresolved)'));
  const viaEnv = await execution(['scripts/deploy.sh'], deploy(wif('${{ env.DEPLOYER }}'), { env: '    env:\n      DEPLOYER: ${{ vars.DEPLOYER }}\n' }), recorder(requests));
  assert.ok(viaEnv.path.includes('requests gcp credentials from service_account ${{ env.DEPLOYER }}, which comes from vars.DEPLOYER (unresolved)'));
  const key = await execution(['package.json'], deploy('          credentials_json: ${{ secrets.GCP_SA_KEY }}'), recorder(requests));
  assert.equal(key.status, 'finding');
  assert.ok(key.path.includes('uses a long-lived gcp key from secrets.GCP_SA_KEY (identity unresolved)'));
  assert.match(key.summary, /requests a long-lived gcp key from secrets\.GCP_SA_KEY/);
  assert.ok(key.limitations.some(item => item.includes('not bound to this repository, branch or workflow')));
  const direct = await execution(['scripts/deploy.sh'], deploy(`          workload_identity_provider: ${provider}`), recorder(requests));
  assert.ok(direct.path.includes('requests gcp credentials from direct workload identity federation without a service account (unresolved)'));
  assert.equal(requests.length, 0);
});

test('per-provider adapters: a provider without one is listed but not assessed', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const check = await execution(['scripts/deploy.sh'], deploy(wif(account)), { aws: recorder(requests) });
  assert.equal(check.status, 'finding');
  assert.equal(requests.length, 0);
  assert.ok(check.path.includes('identity authority not assessed'));
  assert.ok(check.limitations.includes('No workflow identity adapter was configured for gcp; its cloud authority is not assessed.'));
});

test('AWS role settings resolve through literal workflow env', async () => {
  const requests: WorkflowIdentityRequest[] = [];
  const workflow = `on: push
env:
  ROLE: arn:aws:iam::123456789012:role/app-deploy
jobs:
  deploy:
    permissions: {id-token: write}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: {role-to-assume: '\${{ env.ROLE }}', aws-region: us-east-1}
      - run: ./scripts/deploy.sh
`;
  const check = await execution(['scripts/deploy.sh'], workflow, { aws: recorder(requests) });
  assert.equal(requests[0]?.identity, 'arn:aws:iam::123456789012:role/app-deploy');
  assert.ok(check.path.includes('assumes aws arn:aws:iam::123456789012:role/app-deploy in us-east-1 via OIDC'));
});

const pool = 'projects/123456789/locations/global/workloadIdentityPools/github';
const trust = (members: string[], options: { role?: string; condition?: unknown; subject?: string; federation?: string | null } = {}) =>
  gcpGithubWorkloadIdentityTrust([{ role: options.role ?? 'roles/iam.workloadIdentityUser', members, ...(options.condition ? { condition: options.condition } : {}) }],
    { repository: 'acme/app', subject: options.subject ?? 'repo:acme/app:ref:refs/heads/main',
      ...(options.federation === null ? {} : { federation: options.federation ?? provider }) });

test('GCP workload identity bindings admit, exclude or stay unknown for the job token', () => {
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/app`]).trust, 'admits');
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/other`]).trust, 'excludes');
  assert.equal(trust([`principalSet://iam.googleapis.com/projects/999/locations/global/workloadIdentityPools/github/attribute.repository/acme/app`]).trust, 'excludes');
  assert.equal(trust([`principal://iam.googleapis.com/${pool}/subject/repo:acme/app:ref:refs/heads/main`]).trust, 'admits');
  assert.equal(trust([`principal://iam.googleapis.com/${pool}/subject/repo:acme/app:ref:refs/heads/dev`]).trust, 'excludes');
  const all = trust([`principalSet://iam.googleapis.com/${pool}/*`]);
  assert.equal(all.trust, 'admits');
  assert.ok(all.limitations.some(item => item.includes('every identity in the workload identity pool')));
  const owner = trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository_owner/acme`]);
  assert.equal(owner.trust, 'admits');
  assert.ok(owner.limitations.some(item => item.includes('every repository owned by acme')));
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/app`], { condition: { expression: 'x' } }).trust, 'unknown');
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.environment/prod`]).trust, 'unknown');
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/app`], { role: 'projects/acme/roles/deployer' }).trust, 'unknown');
  assert.equal(trust([`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/app`], { role: 'roles/viewer' }).trust, 'excludes');
  const unresolved = trust([`principalSet://iam.googleapis.com/projects/999/locations/global/workloadIdentityPools/other/attribute.repository/acme/app`], { federation: null });
  assert.equal(unresolved.trust, 'admits');
  assert.ok(unresolved.limitations.some(item => item.includes('bindings in every pool are considered')));
  assert.equal(gcpServiceAccountProject(account), 'acme-prod');
  assert.equal(gcpServiceAccountProject('123456789-compute@developer.gserviceaccount.com'), '123456789');
  assert.equal(gcpServiceAccountProject('acme-prod@appspot.gserviceaccount.com'), 'acme-prod');
  assert.equal(gcpServiceAccountProject('someone@example.com'), undefined);
});

/** Recorded GCP response shapes, replayed through the production assessor. */
function recordedGcp(calls: string[], options: { failAll?: boolean } = {}) {
  return gcpWorkflowServiceAccountAssessor({ token: async () => 'private-reader-key', fetch: async (url, init) => {
    const target = new URL(String(url));
    calls.push(`${init?.method} ${target.hostname}${target.pathname}`);
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as any).authorization, 'Bearer private-reader-key');
    if (options.failAll) return new Response('{"error":{"message":"denied for private-reader-key"}}', { status: 403 });
    if (target.hostname === 'iam.googleapis.com') return Response.json({ bindings: [{ role: 'roles/iam.workloadIdentityUser',
      members: [`principalSet://iam.googleapis.com/${pool}/attribute.repository/acme/app`] }] });
    if (target.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ bindings: [
      { role: 'roles/cloudfunctions.developer', members: [`serviceAccount:${account}`, 'user:someone@example.com'] },
      { role: 'roles/firebasehosting.admin', members: [`serviceAccount:${account}`], condition: { expression: 'request.time < x' } },
      { role: 'roles/owner', members: ['user:owner@example.com'] }] });
    const body = JSON.parse(String(init?.body));
    return Response.json({ accessTuple: body.accessTuple,
      overallAccessState: body.accessTuple.permission === 'cloudfunctions.functions.update' ? 'CAN_ACCESS' : 'CANNOT_ACCESS' });
  } });
}

test('GCP service account assessor reads only the named account and its project, with recorded responses', async () => {
  const calls: string[] = [];
  const request: WorkflowIdentityRequest = { provider: 'gcp', identity: account, repository: 'acme/app', branch: 'main', workflow: 'w',
    oidc: true, oidcSubject: 'repo:acme/app:ref:refs/heads/main', federation: provider };
  const result = await recordedGcp(calls)(request, new AbortController().signal);
  assert.equal(result.trust, 'admits');
  assert.deepEqual(result.declaredAuthority, [
    { provider: 'gcp', operation: 'roles/cloudfunctions.developer', resources: { project: ['acme-prod'] } },
    { provider: 'gcp', operation: 'roles/firebasehosting.admin', resources: { project: ['acme-prod'] } }]);
  assert.deepEqual(result.potentialAuthority, [{ provider: 'gcp', operation: 'cloudfunctions.functions.update', resources: { project: ['acme-prod'] } }]);
  assert.ok(result.limitations.some(item => item.includes('roles/firebasehosting.admin on acme-prod is conditional')));
  assert.deepEqual(calls.slice(0, 2), [`POST iam.googleapis.com/v1/projects/-/serviceAccounts/${account}:getIamPolicy`,
    'POST cloudresourcemanager.googleapis.com/v1/projects/acme-prod:getIamPolicy']);
  assert.ok(calls.slice(2).every(call => call === 'POST policytroubleshooter.googleapis.com/v3/iam:troubleshoot'));
  assert.equal(calls.length, 10);
  assert.ok(!JSON.stringify(result).includes('private-reader-key'));
  assert.ok(!JSON.stringify(result).includes('someone@example.com'));

  const denied = await recordedGcp([], { failAll: true })(request, new AbortController().signal);
  assert.equal(denied.trust, 'unknown');
  assert.deepEqual(denied.potentialAuthority, []);
  assert.ok(denied.limitations.some(item => item.includes('IAM policy could not be read')));
  assert.ok(!JSON.stringify(denied).includes('private-reader-key'));
  await assert.rejects(recordedGcp([])({ ...request, provider: 'aws' }, new AbortController().signal), /Unsupported/);
  await assert.rejects(recordedGcp([])({ ...request, identity: 'arn:aws:iam::123456789012:role/x' }, new AbortController().signal), /Unsupported/);
});

test('the GCP assessor completes the workflow path end to end', async () => {
  const check = await execution(['scripts/deploy.sh'], deploy(wif(account)), { gcp: recordedGcp([]) });
  assert.deepEqual(check.path.slice(2), [
    `assumes gcp ${account} via OIDC through ${provider}`,
    'service account bindings admit repo:acme/app:ref:refs/heads/main',
    'gcp:cloudfunctions.functions.update acme-prod (provider-evaluated allow)',
    'gcp:roles/cloudfunctions.developer acme-prod (declared in policy, not provider-evaluated)',
    'gcp:roles/firebasehosting.admin acme-prod (declared in policy, not provider-evaluated)',
  ]);
  assert.ok(check.evidence.some(item => item.source.startsWith('https://cloudresourcemanager.googleapis.com/v1/projects/acme-prod')));
});
