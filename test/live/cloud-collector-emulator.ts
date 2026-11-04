import assert from 'node:assert/strict';
import { awsEvidenceCollector, azureEvidenceCollector } from '../../src/providers/tools/cloud-evidence.js';
import { awsPermissionPreflight, azurePermissionPreflight } from '../../src/providers/tools/preflight.js';
import { createGrant, createToolSession, defineTool } from '../../src/runtime/tools.js';
import { admitToolSession, preflightTools } from '../../src/runtime/preflight.js';
import { runTrustedProcess } from '../../src/providers/shared/process.js';

const [provider, endpoint, resource, expectedIdentity, cli] = process.argv.slice(2);
assert.ok(provider === 'aws' || provider === 'azure');
assert.match(endpoint!, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const subject = 'agent:emulator';
const signal = AbortSignal.timeout(30000);
const operations = provider === 'aws' ? ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'] : ['Microsoft.Compute/virtualMachines/runCommand/action'];
const field = provider === 'aws' ? 'functionArn' : 'resourceId';
const tools = operations.map((id, i) => defineTool({ name: `assess-${i}`,
  credential: { provider, resource: 'emulator', key: 'synthetic', assignment: subject },
  operation: { provider, id, description: 'Assessment only', resourceFields: [field],
    inputSchema: { type: 'object', additionalProperties: false, required: [field], properties: { [field]: { type: 'string' } } },
    execute: async () => { throw Error('No execution'); } } }));
const session = createToolSession({ subject, tools,
  grants: tools.map(tool => createGrant({ subject, tool, resources: { [field]: [resource!] } })),
  context: { executionId: 'emulator', attemptId: 'one', inputDigest: 'emulator', deadlineMs: Date.now() + 30000, signal },
  resolveCredential: async () => { throw Error('No backing credential may be resolved'); } });
const collect = provider === 'aws' ? awsEvidenceCollector({ command: cli!, cwd: process.cwd(),
  environment: { AWS_ACCESS_KEY_ID: 'testing', AWS_SECRET_ACCESS_KEY: 'testing' },
  // Official CLI v2, with only synthetic provider credentials passed into its container.
  process: request => runTrustedProcess({ ...request, env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
    args: ['run', '--rm', ...Object.entries(request.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      'amazon/aws-cli@sha256:77c27e51823293d52691a13e87f6942a4b483e87de3f49d68c25dc271f3528b1',
      ...request.args, '--endpoint-url', endpoint!.replace('127.0.0.1', 'host.docker.internal')] }),
}) : azureEvidenceCollector({ token: async () => 'synthetic-reader', fetch: async (url, init) => {
  const target = new URL(String(url));
  assert.equal(target.origin, 'https://management.azure.com');
  return fetch(endpoint + target.pathname + target.search, init);
} });
const input = { subject, tools, grants: session.grants, now: Date.now(), signal };
const inventory = await collect(input);
assert.ok(inventory.evidence.length > 0, 'Metadata read must succeed');
const identityObserved = inventory.resources.some(item => item.executionIdentity === expectedIdentity);
const simulationUnavailable = inventory.resources.some(item => item.limitations?.some(limit => limit.includes('simulation unavailable')));
if (provider === 'aws') {
  assert.ok(inventory.evidence.some(item => item.source === 'aws:iam:GetRolePolicy'), 'Seeded role policy must be read');
  assert.ok(simulationUnavailable, 'Moto does not implement principal-policy simulation; this must remain explicit');
}
const inspector = provider === 'aws' ? awsPermissionPreflight : azurePermissionPreflight;
const report = await preflightTools(session, { signal, inspectors: [inspector(async () => inventory)] });
assert.throws(() => admitToolSession(session, report), /PREFLIGHT_REQUIREMENT_UNMET/);
const absent = await collect({ ...input, grants: session.grants.map(grant => ({ ...grant, resources: { [field]: [resource + '-absent'] } })) });
assert.equal(absent.resources.length, 0);
assert.equal(absent.evidence.length, 0);
process.stdout.write(JSON.stringify({ provider, identityObserved, unknownBlocksAdmission: true, missingResourceNegativeControl: true,
  ...(provider === 'aws' ? { rolePolicyRead: inventory.evidence.some(item => item.source === 'aws:iam:GetRolePolicy'), simulationUnavailable } : {}), iamProof: false }) + '\n');
if (!identityObserved) process.exitCode = 2; // Unsupported coverage is never a pass.
