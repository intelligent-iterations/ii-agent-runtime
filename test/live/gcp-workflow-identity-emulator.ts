import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { preflightTools } from '../../src/runtime/preflight.js';
import { gcpWorkflowServiceAccountAssessor } from '../../src/providers/tools/cloud-evidence.js';
import { githubPermissionPreflight } from '../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../src/providers/tools/github.js';

// Upstream Floci GCP, the same pinned image as the other GCP runners.
const image = 'floci/floci-gcp@sha256:eae9683d806ceb643bcb36aee97cdb8cad13c3e2959cd053bf40e481994fde12';
const name = `ii-workflow-gcp-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const project = 'ii-workflow';
const account = `deployer@${project}.iam.gserviceaccount.com`;
const provider = 'projects/123456789/locations/global/workloadIdentityPools/github/providers/github';
const repositoryMember = 'principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/attribute.repository/acme/app';
let container: string | undefined;
const result: Record<string, unknown> = { provider: 'gcp', scope: 'workflow service account', emulator: 'floci-gcp', version: '0.11.0', image,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, iamProof: false, status: 'failed' };
try {
  container = docker('run', '-d', '--name', name, '-p', '127.0.0.1::4588', image);
  const endpoint = `http://${docker('port', container, '4588/tcp')}`;
  async function api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return response.status === 204 ? {} : response.json();
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await api('GET', `/v1/projects/${project}`); ready = true; break; } catch { await delay(500); }
  }
  assert.ok(ready, 'Upstream emulator must start');
  // Seed through the provider's own IAM and Resource Manager APIs, then read back.
  const created = await api('POST', `/v1/projects/${project}/serviceAccounts`, { accountId: 'deployer', serviceAccount: { displayName: 'deployer' } });
  assert.equal(created.email, account);
  await api('POST', `/v1/projects/-/serviceAccounts/${account}:setIamPolicy`,
    { policy: { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [repositoryMember] }] } });
  assert.deepEqual((await api('POST', `/v1/projects/-/serviceAccounts/${account}:getIamPolicy`, {})).bindings?.[0]?.members, [repositoryMember]);
  await api('POST', `/v1/projects/${project}:setIamPolicy`, { policy: { bindings: [
    { role: 'roles/cloudfunctions.developer', members: [`serviceAccount:${account}`] },
    { role: 'roles/viewer', members: ['user:someone@example.com'] }] } });
  result.seedReadback = 'passed';

  const hosts = new Set(['iam.googleapis.com', 'cloudresourcemanager.googleapis.com', 'policytroubleshooter.googleapis.com']);
  const statuses: Record<string, number[]> = {};
  let reads = 0;
  // Change only transport destination. Do not synthesize or rewrite responses.
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.ok(hosts.has(target.hostname), `Unexpected host ${target.hostname}`);
    reads++;
    const response = await fetch(endpoint + target.pathname + target.search, init);
    (statuses[target.hostname] ??= []).push(response.status);
    return response;
  };
  const assess = gcpWorkflowServiceAccountAssessor({ token: async () => 'synthetic-reader-token', fetch: transport });
  const request = { provider: 'gcp', identity: account, repository: 'acme/app', branch: 'main', workflow: 'w', oidc: true,
    oidcSubject: 'repo:acme/app:ref:refs/heads/main', federation: provider };
  const direct = await assess(request, new AbortController().signal);
  assert.equal(direct.trust, 'admits');
  assert.deepEqual(direct.declaredAuthority, [{ provider: 'gcp', operation: 'roles/cloudfunctions.developer', resources: { project: [project] } }]);
  assert.deepEqual(direct.potentialAuthority, []);
  assert.ok(direct.limitations.some(item => item.includes('Policy Troubleshooter is unavailable')));
  assert.ok(!JSON.stringify(direct).includes('someone@example.com'));
  result.trustAdmitsRepository = 'passed';
  result.boundRolesRead = 'passed';
  result.policyTroubleshooter = `unavailable in upstream emulator (HTTP ${[...new Set(statuses['policytroubleshooter.googleapis.com'])].join(', ')})`;
  const other = await assess({ ...request, repository: 'acme/other', oidcSubject: 'repo:acme/other:ref:refs/heads/main' }, new AbortController().signal);
  assert.equal(other.trust, 'excludes');
  result.trustExcludesOtherRepository = 'passed';

  // Recorded workflow: the production GitHub preflight joins the job to the account.
  const subject = 'agent:coder';
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: 'acme/app', key: 'test', assignment: subject } });
  const workflow = `on: push
jobs:
  deploy:
    permissions: {id-token: write, contents: read}
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${provider}
          service_account: ${account}
      - run: ./scripts/deploy.sh
`;
  const run = async (paths: string[]) => {
    const tools = createToolSession({ subject, tools: [tool],
      grants: [createGrant({ subject, tool, resources: { repository: ['acme/app'], branch: ['main'], path: paths } })],
      context: { executionId: 'emulator', attemptId: 'emulator', inputDigest: 'sha256:emulator', deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
      resolveCredential: async () => { throw Error('Preflight must not resolve the agent credential'); } });
    const report = await preflightTools(tools, { signal: new AbortController().signal, inspectors: [githubPermissionPreflight(
      async (repository, branch) => ({ repository, branch, actionsEnabled: true, complete: true, source: 'github:recorded-fixture', observedAt: Date.now(),
        workflows: [{ path: '.github/workflows/deploy.yml', content: workflow }] }), { workflowIdentity: { gcp: assess } })] });
    return report.checks.find(item => item.id === 'github.workflow-execution')!;
  };
  const finding = await run(['scripts/deploy.sh']);
  assert.equal(finding.status, 'finding');
  assert.deepEqual(finding.path.slice(2, 5), [`assumes gcp ${account} via OIDC through ${provider}`,
    'service account bindings admit repo:acme/app:ref:refs/heads/main',
    `gcp:roles/cloudfunctions.developer ${project} (declared in policy, not provider-evaluated)`]);
  result.workflowJoin = 'passed';
  const before = reads;
  const clear = await run(['docs/guide.md']);
  assert.equal(clear.status, 'clear');
  assert.equal(reads, before, 'An inert write must not read GCP');
  result.inertWriteClearWithoutReads = 'passed';

  // Negative control: an account that does not exist is never reported as admitted.
  const missing = await assess({ ...request, identity: `missing@${project}.iam.gserviceaccount.com` }, new AbortController().signal);
  assert.notEqual(missing.trust, 'admits');
  assert.deepEqual(missing.declaredAuthority, []);
  result.missingAccountNegativeControl = `passed (trust ${missing.trust})`;

  await api('POST', `/v1/projects/${project}:setIamPolicy`, { policy: { bindings: [] } });
  await api('DELETE', `/v1/projects/${project}/serviceAccounts/${account}`);
  assert.ok(!(await api('GET', `/v1/projects/${project}/serviceAccounts`)).accounts?.some((item: any) => item.email === account));
  result.resourceCleanup = 'passed';
  result.statuses = statuses;
  result.status = 'passed';
} finally {
  if (container) {
    // The image declares a data volume; remove it with the container.
    const volumes = docker('inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', container).split(/\s+/).filter(Boolean);
    docker('rm', '-f', '-v', container);
    assert.ok(!docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.ID}}'));
    for (const volume of volumes) assert.ok(!docker('volume', 'ls', '-q', '--filter', `name=${volume}`), `Volume ${volume} must be removed`);
    result.emulatorCleanup = 'passed';
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
