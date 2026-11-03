import assert from 'node:assert/strict';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { preflightTools } from '../../src/runtime/preflight.js';
import { awsEvidenceCollector, azureEvidenceCollector, gcpEvidenceCollector } from '../../src/providers/tools/cloud-evidence.js';
import { awsPermissionPreflight, azurePermissionPreflight, gcpPermissionPreflight } from '../../src/providers/tools/preflight.js';
import { githubContents } from '../../src/providers/tools/github.js';
import { githubEvidenceCollector, githubPermissionPreflight } from '../../src/providers/tools/github-preflight.js';

// Explicit opt-in, read-only metadata validation. Never runs as part of npm test.
// No provider response, secret, resource name or raw error is printed.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
}
async function main() {
  const provider = process.argv[2];
  if (!['github', 'aws', 'gcp', 'azure'].includes(provider ?? '')) throw Error('Choose github, aws, gcp or azure');
  if (required('II_PREFLIGHT_LIVE') !== 'read-only-test-resources') throw Error('Explicit test-resource selection required');
  const signal = AbortSignal.timeout(30000);
  const subject = 'agent:live-preflight';
  const context = { executionId: 'live-preflight', attemptId: 'one', inputDigest: 'live-preflight', deadlineMs: Date.now() + 30000, signal };
  let backingKeyResolutions = 0;
  const resolveCredential = async () => { backingKeyResolutions++; throw Error('Preflight must not resolve a backing key'); };
  if (provider === 'github') {
    const repository = required('II_PREFLIGHT_GITHUB_REPOSITORY');
    const branch = required('II_PREFLIGHT_GITHUB_BRANCH');
    const path = required('II_PREFLIGHT_GITHUB_SCRIPT');
    const token = required('II_PREFLIGHT_GITHUB_READ_TOKEN');
    const expected = required('II_PREFLIGHT_GITHUB_EXPECTED');
    if (!['finding', 'unknown', 'clear'].includes(expected)) throw Error('Invalid expected GitHub result');
    const collector = githubEvidenceCollector({ token: async () => token });
    // Capture directly as well: an unknown result must not conceal a failed read.
    const evidence = await collector(repository, branch, signal);
    assert.equal(evidence.complete, true);
    const tool = defineTool({ name: 'write-script', operation: githubContents().write,
      credential: { provider, resource: 'live-test', key: 'never-resolved', assignment: subject } });
    const session = createToolSession({ subject, tools: [tool], context, resolveCredential,
      grants: [createGrant({ subject, tool, resources: { repository: [repository], branch: [branch], path: [path] } })] });
    const report = await preflightTools(session, { signal, inspectors: [githubPermissionPreflight(async () => evidence)] });
    assert.equal(report.checks.find(check => check.id === 'github.workflow-execution')?.status, expected);
    assert.equal(backingKeyResolutions, 0);
    assert.ok(!JSON.stringify(report).includes(token));
    process.stdout.write(JSON.stringify({ provider, observedAt: new Date().toISOString(),
      liveMetadataRead: true, snapshotRevision: evidence.source.split('/').at(-1), workflowsRead: evidence.workflows.length, result: expected,
      backingKeyResolutions, escalationExecuted: false, iamProof: false }) + '\n');
    return;
  }
  const resources: Record<string, string[]> = provider === 'gcp' ? {
    project: [required('II_PREFLIGHT_GCP_PROJECT')], zone: [required('II_PREFLIGHT_GCP_ZONE')], instance: [required('II_PREFLIGHT_GCP_INSTANCE')],
  } : provider === 'azure' ? { resourceId: [required('II_PREFLIGHT_AZURE_VM_ID')] } : { functionArn: [required('II_PREFLIGHT_AWS_FUNCTION_ARN')] };
  const expectedIdentity = required('II_PREFLIGHT_EXPECTED_IDENTITY');
  const operations = provider === 'gcp' ? ['compute.instances.setMetadata', 'compute.instances.reset'] :
    provider === 'azure' ? ['Microsoft.Compute/virtualMachines/runCommand/action'] : ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'];
  const tools = operations.map((id, index) => defineTool({ name: `operation-${index}`,
    credential: { provider: provider!, resource: 'live-test', key: 'never-resolved', assignment: subject },
    operation: { provider: provider!, id, description: 'Assessment only; this probe cannot execute this operation', resourceFields: Object.keys(resources),
      inputSchema: { type: 'object', additionalProperties: false, required: Object.keys(resources),
        properties: Object.fromEntries(Object.keys(resources).map(field => [field, { type: 'string' }])) },
      execute: async () => { throw Error('Live preflight probe must not execute operations'); } } }));
  const session = createToolSession({ subject, tools, context, resolveCredential,
    grants: tools.map(tool => createGrant({ subject, tool, resources })) });
  const collector = provider === 'gcp' ? gcpEvidenceCollector({ token: async () => required('II_PREFLIGHT_GCP_READ_TOKEN') }) :
    provider === 'azure' ? azureEvidenceCollector({ token: async () => required('II_PREFLIGHT_AZURE_READ_TOKEN') }) :
      awsEvidenceCollector({ command: required('II_PREFLIGHT_AWS_CLI'), cwd: process.cwd(), environment: {
        AWS_ACCESS_KEY_ID: required('II_PREFLIGHT_AWS_ACCESS_KEY_ID'), AWS_SECRET_ACCESS_KEY: required('II_PREFLIGHT_AWS_SECRET_ACCESS_KEY'),
        ...(process.env.II_PREFLIGHT_AWS_SESSION_TOKEN ? { AWS_SESSION_TOKEN: process.env.II_PREFLIGHT_AWS_SESSION_TOKEN } : {}),
      } });
  const inventory = await collector({ subject, tools: session.tools, grants: session.grants, now: Date.now(), signal });
  assert.ok(inventory.evidence.length > 0, 'Live metadata read must succeed');
  assert.ok(inventory.resources.some(resource => resource.executionIdentity === expectedIdentity), 'Expected attached identity must be observed');
  const inspector = provider === 'gcp' ? gcpPermissionPreflight : provider === 'azure' ? azurePermissionPreflight : awsPermissionPreflight;
  const report = await preflightTools(session, { signal, inspectors: [inspector(async () => inventory)] });
  const id = provider === 'gcp' ? 'gcp.startup-code' : provider === 'azure' ? 'azure.managed-execution' : 'aws.lambda-code-role';
  const check = report.checks.find(item => item.id === id)!;
  assert.equal(check.status, 'unknown');
  assert.ok(check.path.some(item => item.includes(expectedIdentity)));
  assert.equal(backingKeyResolutions, 0);
  const encoded = JSON.stringify(report);
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('II_PREFLIGHT_') && /TOKEN|SECRET_ACCESS_KEY/.test(name) && value) assert.ok(!encoded.includes(value));
  }
  process.stdout.write(JSON.stringify({ provider, observedAt: new Date().toISOString(), liveMetadataRead: true,
    expectedIdentityObserved: true, result: check.status, backingKeyResolutions, escalationExecuted: false, iamProof: false }) + '\n');
}
main().catch(() => { process.stderr.write('Live preflight validation failed. Check explicit inputs, reader access, and expected test-resource state.\n'); process.exitCode = 1; });
