import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awsEvidenceCollector, azureEvidenceCollector, gcpEvidenceCollector } from '../../../src/providers/tools/cloud-evidence.js';
import { awsPermissionPreflight, azurePermissionPreflight, gcpPermissionPreflight } from '../../../src/providers/tools/preflight.js';
import { createGrant, createToolSession, defineTool } from '../../../src/runtime/tools.js';
import { admitToolSession, preflightTools, type PreflightInput } from '../../../src/runtime/preflight.js';

function setup(provider: string, operations: string[], resources: Record<string, string[]>) {
  const tools = operations.map((id, i) => defineTool({ name: `tool-${i}`,
    credential: { provider, resource: 'test', key: 'test', assignment: 'agent:test' },
    operation: { provider, id, description: id, resourceFields: Object.keys(resources),
      inputSchema: { type: 'object', additionalProperties: false, required: Object.keys(resources),
        properties: Object.fromEntries(Object.keys(resources).map(field => [field, { type: 'string' }])) },
      execute: async () => ({}) } }));
  const signal = new AbortController().signal;
  const session = createToolSession({ subject: 'agent:test', tools,
    grants: tools.map(tool => createGrant({ subject: 'agent:test', tool, resources })),
    context: { executionId: 'test', attemptId: 'test', inputDigest: 'test', deadlineMs: Date.now() + 60000, signal },
    resolveCredential: async () => { throw Error('Backing key must not be resolved'); } });
  const input: PreflightInput = { subject: session.subject, tools: session.tools, grants: session.grants, now: Date.now(), signal };
  return { session, input };
}

test('GCP collects only granted instances and retains identity evidence without claiming effective authority', async () => {
  const { session, input } = setup('gcp', ['compute.instances.setMetadata', 'compute.instances.reset'],
    { project: ['test-project'], zone: ['us-central1-a'], instance: ['worker'] });
  let calls = 0;
  const collect = gcpEvidenceCollector({ token: async () => 'private-reader-key', fetch: async (url, init) => {
    if (new URL(String(url)).hostname === 'policytroubleshooter.googleapis.com') return new Response('{}', { status: 403 });
    calls++;
    assert.equal(String(url), 'https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a/instances/worker');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as any).authorization, 'Bearer private-reader-key');
    return Response.json({ name: 'worker', zone: 'https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a',
      serviceAccounts: [{ email: 'worker@test-project.iam.gserviceaccount.com' }], metadata: { secret: 'discard-this' } });
  } });
  const inventory = await collect(input);
  assert.equal(calls, 1);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.resources[0]?.executionIdentity, 'worker@test-project.iam.gserviceaccount.com');
  assert.ok(!JSON.stringify(inventory).includes('discard-this'));
  assert.ok(!JSON.stringify(inventory).includes('private-reader-key'));
  const report = await preflightTools(session, { inspectors: [gcpPermissionPreflight(collect)], signal: input.signal });
  const check = report.checks.find(item => item.id === 'gcp.startup-code')!;
  assert.equal(check.status, 'unknown');
  assert.ok(check.path.some(item => item.includes('worker@test-project')));
});

test('GCP automatically assesses the reached service account on the exact instance', async () => {
  const { session, input } = setup('gcp', ['compute.instances.setMetadata', 'compute.instances.reset'],
    { project: ['test-project'], zone: ['us-central1-a'], instance: ['worker'] });
  let decision = 'CAN_ACCESS';
  const collect = gcpEvidenceCollector({ token: async () => 'reader', fetch: async (url, init) => {
    if (new URL(String(url)).hostname === 'compute.googleapis.com') return Response.json({ name: 'worker',
      zone: 'https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a',
      serviceAccounts: [{ email: 'worker@test-project.iam.gserviceaccount.com' }] });
    assert.equal(String(url), 'https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const { accessTuple } = JSON.parse(String(init?.body));
    assert.equal(accessTuple.principal, 'worker@test-project.iam.gserviceaccount.com');
    assert.equal(accessTuple.fullResourceName, '//compute.googleapis.com/projects/test-project/zones/us-central1-a/instances/worker');
    return Response.json({ accessTuple, overallAccessState: accessTuple.permission === 'compute.instances.delete' ? decision : 'CANNOT_ACCESS' });
  } });
  const inspect = () => preflightTools(session, { signal: input.signal, inspectors: [gcpPermissionPreflight(collect)] });
  const report = await inspect();
  const check = report.checks.find(item => item.id === 'gcp.startup-code')!;
  assert.equal(check.status, 'finding');
  assert.ok(check.path.includes('gcp:compute.instances.delete'));
  assert.ok(check.summary.startsWith('Potential escalation'));
  assert.throws(() => admitToolSession(session, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  const alreadyGranted = setup('gcp', ['compute.instances.setMetadata', 'compute.instances.reset', 'compute.instances.delete'],
    { project: ['test-project'], zone: ['us-central1-a'], instance: ['worker'] });
  const withinGrants = await preflightTools(alreadyGranted.session, { signal: input.signal, inspectors: [gcpPermissionPreflight(collect)] });
  assert.equal(withinGrants.checks.find(item => item.id === 'gcp.startup-code')!.status, 'unknown', 'Authority already granted is not an escalation finding');
  decision = 'UNKNOWN_CONDITIONAL';
  assert.equal((await inspect()).checks.find(item => item.id === 'gcp.startup-code')!.status, 'unknown');
});

test('cloud collection does not expand read-only grants, invalid paths, or oversized grant products', async () => {
  let calls = 0;
  const collect = gcpEvidenceCollector({ token: async () => { calls++; return 'key'; } });
  for (const input of [
    setup('gcp', ['compute.instances.get'], { project: ['test'], zone: ['zone'], instance: ['worker'] }).input,
    setup('gcp', ['compute.instances.reset'], { project: ['../other'], zone: ['zone'], instance: ['worker'] }).input,
    setup('gcp', ['compute.instances.reset'], { project: ['test'], zone: ['zone'], instance: Array.from({ length: 65 }, (_, i) => `vm-${i}`) }).input,
  ]) assert.deepEqual((await collect(input)).resources, []);
  assert.equal(calls, 0);
});

test('Azure reads the exact VM and strips unrelated properties and errors', async () => {
  const id = '/subscriptions/12345678-1234-1234-1234-123456789012/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/worker';
  const { input } = setup('azure', ['Microsoft.Compute/virtualMachines/runCommand/action'], { resourceId: [id] });
  const principalId = '87654321-1234-1234-1234-123456789012';
  const collect = azureEvidenceCollector({ token: async () => 'reader-key', fetch: async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/denyAssignments') || new URL(String(url)).pathname.endsWith('/roleAssignments')) return Response.json({ value: [] });
    assert.equal(String(url), `https://management.azure.com${id}?api-version=2024-11-01`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ id, identity: { principalId }, properties: { private: 'discard-this' } });
  } });
  const inventory = await collect(input);
  assert.equal(inventory.resources[0]?.executionIdentity, principalId);
  assert.equal(inventory.complete, false);
  assert.ok(!JSON.stringify(inventory).includes('discard-this'));
  const failure = await azureEvidenceCollector({ token: async () => { throw Error('secret-error'); } })(input);
  assert.deepEqual(failure.resources, []);
  assert.ok(!JSON.stringify(failure).includes('secret-error'));
});

test('Azure collector follows VM identity to scoped RBAC and refuses unresolved deny assignments', async () => {
  const subscription = '/subscriptions/12345678-1234-1234-1234-123456789012';
  const id = `${subscription}/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/worker`;
  const principal = '87654321-1234-1234-1234-123456789012';
  const role = `${subscription}/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000003`;
  const { session, input } = setup('azure', ['Microsoft.Compute/virtualMachines/runCommand/action'], { resourceId: [id] });
  let deny = false;
  const collect = azureEvidenceCollector({ token: async () => 'reader', fetch: async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://management.azure.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    if (target.pathname === id) return Response.json({ id, identity: { principalId: principal } });
    if (target.pathname.endsWith('/denyAssignments')) return Response.json({ value: deny ? [{ properties: { scope: id } }] : [] });
    if (target.pathname.endsWith('/roleAssignments')) return Response.json({ value: [{ properties: { principalId: principal, scope: subscription, roleDefinitionId: role } }] });
    assert.equal(target.pathname, role);
    return Response.json({ id: role, properties: { permissions: [{ actions: ['Microsoft.Compute/virtualMachines/delete'], notActions: [] }] } });
  } });
  const inspect = () => preflightTools(session, { signal: input.signal, inspectors: [azurePermissionPreflight(collect)] });
  const report = await inspect();
  const check = report.checks.find(item => item.id === 'azure.managed-execution')!;
  assert.equal(check.status, 'finding');
  assert.ok(check.summary.startsWith('Potential escalation'));
  assert.ok(check.path.includes('azure:Microsoft.Compute/virtualMachines/delete'));
  assert.throws(() => admitToolSession(session, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  deny = true;
  const denied = await inspect();
  assert.equal(denied.checks.find(item => item.id === 'azure.managed-execution')!.status, 'unknown');
});

test('AWS collection uses fixed read argv with isolated credentials and never retains function configuration', async () => {
  const arn = 'arn:aws:lambda:us-east-1:123456789012:function:worker';
  const role = 'arn:aws:iam::123456789012:role/worker';
  const { input } = setup('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'], { functionArn: [arn] });
  let calls = 0;
  const collect = awsEvidenceCollector({ command: '/test/aws', cwd: '/tmp', environment: { AWS_ACCESS_KEY_ID: 'reader-id', AWS_SECRET_ACCESS_KEY: 'private-key' },
    process: async request => {
      if (request.args[0] === 'iam') {
        assert.ok(['list-role-policies', 'list-attached-role-policies'].includes(request.args[1]!));
        assert.deepEqual(request.args.slice(2), ['--role-name', 'worker', '--no-paginate', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager']);
        return JSON.stringify({ PolicyNames: [], AttachedPolicies: [] });
      }
      calls++;
      assert.deepEqual(request.args, ['lambda', 'get-function-configuration', '--function-name', arn, '--region', 'us-east-1',
        '--query', '{FunctionArn:FunctionArn,Role:Role}', '--output', 'json', '--no-cli-pager']);
      assert.equal(request.env.AWS_EC2_METADATA_DISABLED, 'true');
      assert.equal(request.env.AWS_CONFIG_FILE, '/dev/null');
      assert.equal(request.env.HOME, undefined);
      assert.equal(request.env.AWS_PROFILE, undefined);
      return JSON.stringify({ FunctionArn: arn, Role: role, Environment: { Variables: { secret: 'discard-this' } } });
    } });
  const inventory = await collect(input);
  assert.equal(calls, 1);
  assert.equal(inventory.resources[0]?.executionIdentity, role);
  assert.equal(inventory.complete, false);
  assert.ok(!JSON.stringify(inventory).includes('discard-this'));
  assert.ok(!JSON.stringify(inventory).includes('private-key'));
  assert.throws(() => awsEvidenceCollector({ command: '/test/aws', cwd: '/tmp', environment: { AWS_ENDPOINT_URL: 'https://attacker.invalid' } }), /Unsupported/);
});

test('AWS collector feeds automatically discovered role authority into preflight without a caller-authored inventory', async () => {
  const arn = 'arn:aws:lambda:us-east-1:123456789012:function:worker';
  const role = 'arn:aws:iam::123456789012:role/worker';
  const target = 'arn:aws:s3:::test-bucket/object';
  const { session, input } = setup('aws', ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'], { functionArn: [arn] });
  let decision = 'allowed';
  const collector = awsEvidenceCollector({ command: '/test/aws', cwd: '/tmp', environment: {}, process: async request => {
    switch (request.args[1]) {
      case 'get-function-configuration': return JSON.stringify({ FunctionArn: arn, Role: role });
      case 'list-role-policies': return JSON.stringify({ PolicyNames: ['read-object'] });
      case 'get-role-policy': return JSON.stringify({ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: target }] } });
      case 'list-attached-role-policies': return JSON.stringify({ AttachedPolicies: [] });
      case 'simulate-principal-policy': return JSON.stringify({ EvaluationResults: [{ EvalActionName: 's3:GetObject', EvalResourceName: target, EvalDecision: decision, MissingContextValues: [] }] });
      default: throw Error('Unexpected AWS read');
    }
  } });
  const inspect = () => preflightTools(session, { signal: input.signal, inspectors: [awsPermissionPreflight(collector)] });
  const report = await inspect();
  const check = report.checks.find(item => item.id === 'aws.lambda-code-role')!;
  assert.equal(check.status, 'finding');
  assert.ok(check.summary.startsWith('Potential escalation'));
  assert.ok(check.path.includes('aws:s3:GetObject'));
  assert.ok(check.evidence.some(item => item.source === 'aws:iam:SimulatePrincipalPolicy'));
  assert.throws(() => admitToolSession(session, report), /PREFLIGHT_REQUIREMENT_UNMET/);
  decision = 'explicitDeny';
  assert.equal((await inspect()).checks.find(item => item.id === 'aws.lambda-code-role')!.status, 'unknown');
});
