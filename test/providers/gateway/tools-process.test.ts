import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createGrant, createToolSession, defineTool } from '../../../src/runtime/tools.js';
import { admitToolSession, preflightTools } from '../../../src/runtime/preflight.js';
import { gcpCompute } from '../../../src/providers/tools/gcp.js';
import { gcpPermissionPreflight } from '../../../src/providers/tools/preflight.js';
import { openWorkerGateway } from '../../../src/providers/gateway/worker.js';

test('a separate stock Node process receives only a tool handle; independent HTTP observer sees only allowed requests', async t => {
  const key = `test-only-admin-${randomBytes(24).toString('hex')}`;
  const observed: { path: string; authorization: string | undefined }[] = [];
  const upstream = createServer((request, response) => {
    observed.push({ path: request.url!, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [{ name: 'vm-a' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const provider = gcpCompute({ fetch: (url, init) => {
    const target = new URL(String(url));
    return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, init);
  } });
  const tool = defineTool({ name: 'compute-list', operation: provider.listInstances,
    credential: { provider: 'gcp', resource: 'compute', key: 'admin-reference', assignment: 'agent:read' } });
  const controller = new AbortController();
  const session = createToolSession({ subject: 'agent:read', tools: [tool],
    grants: [createGrant({ subject: 'agent:read', tool, resources: { project: ['project-a'], zone: ['zone-a'] } })],
    context: { executionId: 'test-run', attemptId: 'attempt', inputDigest: 'sha256:test', deadlineMs: Date.now() + 30000, signal: controller.signal },
    resolveCredential: async () => ({ values: { accessToken: key }, expiresAt: Date.now() + 30000 }) });
  const report = await preflightTools(session, { inspectors: [gcpPermissionPreflight()], signal: controller.signal });
  admitToolSession(session, report);
  const gateway = await openWorkerGateway({ address: '127.0.0.1', grants: [], tools: session, signal: controller.signal,
    model: { respond: async () => { throw Error('No model in this test'); } } });
  t.after(() => gateway.close());
  const script = `
    const headers = {authorization: 'Bearer ' + process.env.TOOL_HANDLE};
    const call = async (name, project) => {
      const result = await fetch(process.env.TOOL_ENDPOINT + '/tools/' + name, {
        method: 'POST', headers, body: JSON.stringify({project, zone:'zone-a'})
      });
      return {status: result.status, body: await result.text()};
    };
    const results = [await call('compute-list','project-a'), await call('compute-list','project-b'), await call('compute-delete','project-a')];
    console.log(JSON.stringify({environment: process.env, results}));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { TOOL_ENDPOINT: gateway.endpoint, TOOL_HANDLE: gateway.token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  const result = JSON.parse(output);
  assert.deepEqual(result.results.map((item: any) => item.status), [200, 403, 403]);
  assert.deepEqual(observed, [{ path: '/compute/v1/projects/project-a/zones/zone-a/instances', authorization: `Bearer ${key}` }]);
  const leaks = (text: string) => text.includes(key) || text.includes(Buffer.from(key).toString('base64'));
  assert.equal(leaks(JSON.stringify({ planted: key })), true, 'validate the detector with a planted positive');
  assert.equal(leaks(output + errors + JSON.stringify(report) + JSON.stringify(gateway.snapshot())), false);
});
