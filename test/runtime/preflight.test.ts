import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { admitToolSession, assertToolSessionAdmitted, preflightTools, type PreflightCheck, type PreflightInspector } from '../../src/runtime/preflight.js';
import { awsPermissionPreflight, azurePermissionPreflight, gcpPermissionPreflight, type AuthorityInventory } from '../../src/providers/tools/preflight.js';
import { githubPermissionPreflight } from '../../src/providers/tools/github-preflight.js';
import { githubContents } from '../../src/providers/tools/github.js';

function session(provider: string, operations: string[], scopes = operations.map(() => 'resource-a'), key = 'test', constrained = false) {
  const tools = operations.map((id, index) => defineTool({ name: `tool-${index}`, credential: { provider, resource: 'test', key, assignment: 'agent:test' },
    operation: { provider, id, description: id, resourceFields: ['resource'],
      inputSchema: { type: 'object', additionalProperties: false, required: ['resource'], properties: { resource: { type: 'string' }, payload: { type: 'string' } } },
      execute: async () => ({ ok: true }) } }));
  return createToolSession({ subject: 'agent:test', tools,
    grants: tools.map((tool, index) => createGrant({ subject: 'agent:test', tool, resources: { resource: [scopes[index]!] },
      ...(constrained ? { arguments: { payload: ['approved-payload'] } } : {}) })),
    context: { executionId: 'run', attemptId: 'attempt', inputDigest: 'sha256:test', deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
    resolveCredential: async () => { throw Error('Preflight must not resolve the agent backing key'); } });
}
const inventory = (provider: string): AuthorityInventory => ({ provider, complete: true,
  evidence: [{ source: 'provider:test-capture', observedAt: Date.now(), resource: 'resource-a' }],
  resources: [{ scope: { resource: ['resource-a'] }, executionIdentity: 'identity:privileged', independentApproval: false,
    authority: [{ provider, operation: 'ungranted.operation', resources: { resource: ['production'] } }] }] });
const run = (input: ReturnType<typeof session>, inspectors: PreflightInspector[]) => preflightTools(input, { inspectors, signal: new AbortController().signal });

test('cloud rules do not treat a restricted payload as arbitrary code or borrow unrestricted grants from another resource', async () => {
  const constrained = session('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'], undefined, 'test', true);
  const report = await run(constrained, [awsPermissionPreflight(async () => inventory('aws'))]);
  const check = report.checks.find(item => item.id === 'aws.lambda-code-role')!;
  assert.equal(check.status, 'unknown');
  assert.ok(check.limitations.some(item => item.includes('Argument restrictions')));
  const inspector = awsPermissionPreflight(async () => inventory('aws'));
  const unrelated = constrained.grants.map(grant => ({ ...grant, resources: { resource: ['resource-b'] }, arguments: {} }));
  const checks = await inspector.inspect({ subject: constrained.subject, tools: constrained.tools,
    grants: [...constrained.grants, ...unrelated], now: Date.now(), signal: new AbortController().signal });
  assert.equal(checks.find(item => item.id === 'aws.lambda-code-role')!.status, 'unknown');
  const allowed = constrained.grants.map(grant => ({ ...grant, arguments: {} }));
  const proven = await inspector.inspect({ subject: constrained.subject, tools: constrained.tools,
    grants: [...constrained.grants, ...allowed], now: Date.now(), signal: new AbortController().signal });
  assert.equal(proven.find(item => item.id === 'aws.lambda-code-role')!.status, 'finding');
});

test('AWS combines granted operations, relates their scopes, and derives ungranted authority from evidence', async () => {
  const input = session('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction']);
  const report = await run(input, [awsPermissionPreflight(async () => inventory('aws'))]);
  const check = report.checks.find(check => check.id === 'aws.lambda-code-role')!;
  assert.equal(check.status, 'finding');
  assert.ok(check.path.includes('aws:ungranted.operation'));
  assert.throws(() => admitToolSession(input, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  const separated = session('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'], ['resource-a', 'resource-b']);
  const separatedReport = await run(separated, [awsPermissionPreflight(async () => inventory('aws'))]);
  assert.equal(separatedReport.checks.find(check => check.id === 'aws.lambda-code-role')!.status, 'not-applicable');
});

test('GCP actAs alone is not treated as token minting or executable resource creation', async () => {
  const input = session('gcp', ['iam.serviceAccounts.actAs']);
  const report = await run(input, [gcpPermissionPreflight()]);
  assert.equal(report.checks.find(check => check.id === 'gcp.identity-access')!.status, 'not-applicable');
  assert.equal(report.checks.find(check => check.id === 'gcp.execution-identity')!.status, 'not-applicable');
  const combined = session('gcp', ['iam.serviceAccounts.actAs', 'compute.instances.create']);
  const combinedReport = await run(combined, [gcpPermissionPreflight(async () => inventory('gcp'))]);
  assert.equal(combinedReport.checks.find(check => check.id === 'gcp.execution-identity')!.status, 'finding');
});

test('Azure role assignment and managed identity combinations require evidence; resource write alone does not satisfy assignment rule', async () => {
  const input = session('azure', ['Microsoft.Authorization/roleAssignments/write']);
  const report = await run(input, [azurePermissionPreflight()]);
  assert.equal(report.checks.find(check => check.id === 'azure.role-assignment')!.status, 'unknown');
  const resourceOnly = session('azure', ['Microsoft.Compute/virtualMachines/write']);
  const resourceReport = await run(resourceOnly, [azurePermissionPreflight()]);
  assert.equal(resourceReport.checks.find(check => check.id === 'azure.identity-assignment')!.status, 'not-applicable');
  const combined = session('azure', ['Microsoft.Compute/virtualMachines/write', 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action']);
  const combinedReport = await run(combined, [azurePermissionPreflight(async () => inventory('azure'))]);
  assert.equal(combinedReport.checks.find(check => check.id === 'azure.identity-assignment')!.status, 'finding');
});

test('stale evidence, unsupported operations and collector failures cannot produce a passing mandatory check', async () => {
  const input = session('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction', 'unknown:Operation']);
  const old = inventory('aws'); old.evidence[0]!.observedAt -= 3600000;
  const report = await run(input, [awsPermissionPreflight(async () => old)]);
  assert.equal(report.coverage, 'partial');
  assert.equal(report.checks.find(check => check.id === 'aws.lambda-code-role')!.status, 'unknown');
  assert.equal(report.checks.find(check => check.id === 'aws.coverage')!.status, 'unknown');
  assert.throws(() => admitToolSession(input, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  const failure = await run(input, [awsPermissionPreflight(async () => { throw Error('secret-token-in-provider-error'); })]);
  assert.ok(!JSON.stringify(failure).includes('secret-token'));
  assert.ok(failure.checks.every(check => check.status === 'unknown'));
});

test('reports are configuration-bound, cannot be forged, and admission preserves advisory findings', async () => {
  const input = session('gcp', ['compute.instances.list']);
  assert.throws(() => assertToolSessionAdmitted(input), /PREFLIGHT_REQUIRED/);
  const report = await run(input, [gcpPermissionPreflight()]);
  assert.throws(() => admitToolSession(input, { ...report }), /PREFLIGHT_STALE_OR_CHANGED/);
  admitToolSession(input, report);
  assertToolSessionAdmitted(input);
  const changed = session('gcp', ['compute.instances.list'], ['resource-b']);
  assert.throws(() => admitToolSession(changed, report), /PREFLIGHT_STALE_OR_CHANGED/);
  const changedCredential = session('gcp', ['compute.instances.list'], ['resource-a'], 'another-credential');
  assert.throws(() => admitToolSession(changedCredential, report), /PREFLIGHT_STALE_OR_CHANGED/);
  const unsupported = session('unrecognized', ['custom-operation']);
  const advisory = await run(unsupported, []);
  assert.throws(() => admitToolSession(unsupported, advisory), /PREFLIGHT_REQUIREMENT_UNMET/);
  admitToolSession(unsupported, advisory, []);
  assert.equal(advisory.coverage, 'partial', 'advisory admission never rewrites the assessment');
});

test('preflight times out a collector that ignores cancellation', async () => {
  const input = session('gcp', ['compute.instances.list']);
  const inspector: PreflightInspector = { provider: 'gcp', checks: ['gcp.test'], inspect: () => new Promise(() => {}) };
  // Keep an event-loop handle while the runtime timeout (which is unrefed by Node) fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await preflightTools(input, { inspectors: [inspector], signal: new AbortController().signal, timeoutMs: 10 });
    assert.equal(result.checks[0]!.status, 'unknown');
  } finally { clearInterval(keepAlive); }
});

test('GitHub detects ability to create a workflow even when no workflow currently exists', async () => {
  const tool = defineTool({ name: 'write-file', operation: githubContents().write,
    credential: { provider: 'github', resource: 'org/repo', key: 'app', assignment: 'agent:test' } });
  const input = createToolSession({ subject: 'agent:test', tools: [tool],
    grants: [createGrant({ subject: 'agent:test', tool, resources: { repository: ['org/repo'], branch: ['agent/work'], path: ['.github/workflows/new.yml'] } })],
    context: { executionId: 'run', attemptId: 'attempt', inputDigest: 'sha256:test', deadlineMs: Date.now() + 60000, signal: new AbortController().signal },
    resolveCredential: async () => { throw Error('must not resolve'); } });
  const report = await run(input, [githubPermissionPreflight(async (repository, branch) => ({ repository, branch, actionsEnabled: true,
    workflows: [], observedAt: Date.now(), source: 'github:captured-repository', complete: true }))]);
  const check = report.checks.find(check => check.id === 'github.workflow-definition')!;
  assert.equal(check.status, 'unknown');
  assert.ok(check.path.includes('potential new workflow execution'));
  assert.throws(() => admitToolSession(input, report), /PREFLIGHT_REQUIREMENT_UNMET/);
});
