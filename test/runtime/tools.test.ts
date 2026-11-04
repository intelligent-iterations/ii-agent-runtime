import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrant, createToolSession, defineTool, narrowGrant, type ToolOperation } from '../../src/runtime/tools.js';
import { gcpCompute } from '../../src/providers/tools/gcp.js';
import { admitToolSession, preflightTools } from '../../src/runtime/preflight.js';
import { gcpPermissionPreflight } from '../../src/providers/tools/preflight.js';
import { openWorkerGateway } from '../../src/providers/gateway/worker.js';

const credential = { provider: 'gcp', resource: 'compute', key: 'admin', assignment: 'agent:reader' };
const context = () => ({ executionId: 'run-1', attemptId: 'attempt-1', inputDigest: 'sha256:test',
  deadlineMs: Date.now() + 60000, signal: new AbortController().signal });

test('real HTTP gateway narrows an admin key, isolates credentials, and disables legacy bypass routes', async t => {
  const requests: { url: string; authorization: string }[] = [];
  let resolutions = 0;
  const provider = gcpCompute({ fetch: async (url, init) => {
    requests.push({ url: String(url), authorization: (init!.headers as Record<string, string>).authorization! });
    return Response.json({ items: [{ name: 'instance-a' }] });
  } });
  const list = defineTool({ name: 'list-compute', operation: provider.listInstances, credential });
  const remove = defineTool({ name: 'delete-compute', operation: provider.deleteInstance, credential });
  const grant = createGrant({ subject: 'agent:reader', tool: list, resources: { project: ['project-a'], zone: ['zone-a'] } });
  const session = createToolSession({ subject: 'agent:reader', tools: [list, remove], grants: [grant], context: context(),
    resolveCredential: async () => { resolutions++; return { values: { accessToken: 'synthetic-private-admin-key' }, expiresAt: Date.now() + 60000 }; } });
  const report = await preflightTools(session, { inspectors: [gcpPermissionPreflight()], signal: new AbortController().signal });
  admitToolSession(session, report, ['gcp.coverage', 'gcp.identity-access', 'gcp.execution-identity', 'gcp.startup-code', 'gcp.policy-expansion']);
  const gateway = await openWorkerGateway({ address: '127.0.0.1', grants: [], tools: session,
    signal: new AbortController().signal, model: { respond: async () => Response.json({}) } });
  t.after(() => gateway.close());
  const headers = { authorization: `Bearer ${gateway.token}` };
  const invoke = (tool: string, input: unknown) => fetch(`${gateway.endpoint}/tools/${tool}`, { method: 'POST', headers, body: JSON.stringify(input) });
  const response = await invoke('list-compute', { project: 'project-a', zone: 'zone-a' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [{ name: 'instance-a' }] });
  assert.equal(requests[0]!.authorization, 'Bearer synthetic-private-admin-key');
  assert.equal(requests[0]!.url, 'https://compute.googleapis.com/compute/v1/projects/project-a/zones/zone-a/instances');
  assert.equal((await invoke('list-compute', { project: 'project-b', zone: 'zone-a' })).status, 403);
  assert.equal((await invoke('delete-compute', { project: 'project-a', zone: 'zone-a', instance: 'instance-a' })).status, 403);
  assert.equal((await invoke('list-compute', { project: 'project-a', zone: 'zone-a', subject: 'agent:admin' })).status, 400);
  assert.equal((await fetch(`${gateway.endpoint}/github/org/repo/contents/file`, { headers })).status, 403);
  assert.equal((await fetch(`${gateway.endpoint}/git/org/repo.git/info/refs?service=git-upload-pack`, { headers })).status, 403);
  assert.equal(resolutions, 1, 'denied calls do not resolve credentials');
  assert.equal(requests.length, 1, 'denied calls do not reach the provider');
  const description = await (await fetch(`${gateway.endpoint}/tools`, { headers })).text();
  assert.ok(!description.includes('synthetic-private-admin-key'));
  assert.ok(!description.includes('delete-compute'));
  assert.ok(!description.includes('credential'));
  assert.equal((await fetch(`${gateway.endpoint}/tools`)).status, 403);
});

test('matching does not cross-multiply grants or accept unsupported wildcard scope', async () => {
  const tool = defineTool({ name: 'compute', operation: gcpCompute({ fetch: async () => Response.json({ ok: true }) }).listInstances, credential });
  const grant = (project: string, zone: string) => createGrant({ subject: 'agent:reader', tool, resources: { project: [project], zone: [zone] } });
  const session = createToolSession({ subject: 'agent:reader', tools: [tool], grants: [grant('project-a', 'zone-a'), grant('project-b', 'zone-b')], context: context(),
    resolveCredential: async () => ({ values: { accessToken: 'synthetic-private-key' }, expiresAt: Date.now() + 60000 }) });
  await assert.rejects(session.invoke('compute', { project: 'project-a', zone: 'zone-b' }), /TOOL_DENIED/);
  await assert.rejects(session.invoke('compute', { project: 'project-b', zone: 'zone-a' }), /TOOL_DENIED/);
  assert.throws(() => grant('*', 'zone-a'), /TOOL_INVALID_CONSTRAINT/);
  assert.throws(() => createGrant({ subject: 'agent:reader', tool, resources: { project: ['project-a'] } }), /TOOL_MISSING_RESOURCE/);
  assert.throws(() => narrowGrant(grant('project-a', 'zone-a'), { resources: { project: ['project-b'], zone: ['zone-a'] } }), /TOOL_GRANT_WIDENING/);
  assert.throws(() => createGrant({ subject: 'agent:reader', tool, resources: { project: ['project-a'], zone: ['zone-a'] }, effect: 'deny' } as any), /TOOL_UNSUPPORTED_FIELD/);
  assert.throws(() => (tool.inputSchema as any).additionalProperties = true, TypeError);
});

test('cancellation reaches a trusted executor and a hanging resolver cannot outlive the call deadline', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const tool = defineTool({ name: 'compute', operation: { ...gcpCompute().listInstances,
    execute: async (_input, _credential, context) => { received = context.signal; controller.abort(); return new Promise(() => {}); } }, credential });
  const session = createToolSession({ subject: 'agent:reader', tools: [tool],
    grants: [createGrant({ subject: 'agent:reader', tool, resources: { project: ['project-a'], zone: ['zone-a'] } })],
    context: { ...context(), signal: controller.signal },
    resolveCredential: async () => ({ values: { accessToken: 'synthetic-private-key' }, expiresAt: Date.now() + 60000 }) });
  await assert.rejects(session.invoke('compute', { project: 'project-a', zone: 'zone-a' }), /TOOL_EXECUTION_FAILED/);
  assert.equal(received?.aborted, true);
  const hanging = createToolSession({ subject: 'agent:reader', tools: [tool], grants: session.grants,
    context: { ...context(), deadlineMs: Date.now() + 20 }, resolveCredential: () => new Promise(() => {}) });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(hanging.invoke('compute', { project: 'project-a', zone: 'zone-a' }), /TOOL_EXECUTION_FAILED/); }
  finally { clearInterval(keepAlive); }
});

test('upstream error and secret echoes are not returned, and expired credentials never execute', async () => {
  for (const mode of ['error', 'echo', 'expired']) {
    let calls = 0;
    const operation: ToolOperation = { ...gcpCompute().listInstances,
      execute: async () => { calls++; if (mode === 'error') throw Error('sensitive-upstream-secret'); return { token: 'sensitive-upstream-secret' }; } };
    const tool = defineTool({ name: 'compute', operation, credential });
    const session = createToolSession({ subject: 'agent:reader', tools: [tool],
      grants: [createGrant({ subject: 'agent:reader', tool, resources: { project: ['project-a'], zone: ['zone-a'] } })], context: context(),
      resolveCredential: async () => ({ values: { accessToken: 'sensitive-upstream-secret' }, expiresAt: Date.now() + (mode === 'expired' ? -1 : 60000) }) });
    await assert.rejects(session.invoke('compute', { project: 'project-a', zone: 'zone-a' }), error => {
      assert.equal((error as Error).message, 'TOOL_EXECUTION_FAILED'); return true;
    });
    assert.equal(calls, mode === 'expired' ? 0 : 1);
  }
});

test('closing the gateway cancels outstanding tool execution even when session cancellation is separate', async () => {
  let started!: () => void;
  const executing = new Promise<void>(resolve => { started = resolve; });
  let providerSignal: AbortSignal | undefined;
  const tool = defineTool({ name: 'compute', operation: { ...gcpCompute().listInstances,
    execute: async (_input, _credential, context) => { providerSignal = context.signal; started(); return new Promise(() => {}); } }, credential });
  const session = createToolSession({ subject: 'agent:reader', tools: [tool],
    grants: [createGrant({ subject: 'agent:reader', tool, resources: { project: ['project-a'], zone: ['zone-a'] } })], context: context(),
    resolveCredential: async () => ({ values: { accessToken: 'synthetic-private-key' }, expiresAt: Date.now() + 60000 }) });
  const report = await preflightTools(session, { inspectors: [gcpPermissionPreflight()], signal: new AbortController().signal });
  admitToolSession(session, report);
  const gateway = await openWorkerGateway({ address: '127.0.0.1', grants: [], tools: session,
    signal: new AbortController().signal, model: { respond: async () => Response.json({}) } });
  const request = fetch(`${gateway.endpoint}/tools/compute`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ project: 'project-a', zone: 'zone-a' }) }).catch(() => undefined);
  try {
    await executing;
    await gateway.close();
    assert.equal(providerSignal?.aborted, true);
    await request;
  } finally { await gateway.close(); }
});
