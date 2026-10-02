import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorkerGateway } from '../src/providers/worker-gateway.js';

test('real gateway routes distinct repository credentials and denies unconfigured repositories, read-only pushes and issue creation', async t => {
  const calls: Array<{ url: string; credential: string }> = [];
  const gateway = await openWorkerGateway({ address: '127.0.0.1', signal: new AbortController().signal,
    grants: ['target', 'library'].map((name, index) => ({ repository: `sample/${name}`, repositoryId: index + 1,
      token: `synthetic-${name}-credential`, expiresAt: new Date(Date.now() + 60000).toISOString(), permissions: { contents: index === 0 ? 'write' : 'read' } })),
    model: { respond: async () => new Response('synthetic model stream') },
    fetch: async (url, request) => {
      calls.push({ url: String(url), credential: (request?.headers as Record<string, string>).authorization! });
      return new Response('synthetic git payload', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    } });
  t.after(() => gateway.close());
  const headers = { authorization: `Bearer ${gateway.token}` };
  assert.equal((await fetch(`${gateway.endpoint}/git/sample/target.git/info/refs?service=git-upload-pack`)).status, 403);
  for (const name of ['target', 'library']) {
    const response = await fetch(`${gateway.endpoint}/git/sample/${name}.git/info/refs?service=git-upload-pack`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'synthetic git payload');
  }
  assert.ok(calls[0]!.credential.includes(Buffer.from('x-access-token:synthetic-target-credential').toString('base64')));
  assert.ok(calls[1]!.credential.includes(Buffer.from('x-access-token:synthetic-library-credential').toString('base64')));
  for (const path of ['/git/sample/unconfigured.git/info/refs?service=git-upload-pack',
    '/git/sample/library.git/info/refs?service=git-receive-pack', '/github/sample/unconfigured/contents']) {
    assert.equal((await fetch(gateway.endpoint + path, { headers })).status, 502);
  }
  assert.equal((await fetch(`${gateway.endpoint}/github/sample/target/issues`, { method: 'POST', headers, body: '{}' })).status, 502);
  assert.equal(calls.length, 2);
  const response = await fetch(`${gateway.endpoint}/v1/responses`, { method: 'POST', headers, body: '{}' });
  assert.equal(await response.text(), 'synthetic model stream');
  assert.ok(!JSON.stringify(gateway.snapshot()).includes('credential'));
});

test('upstream exceptions never expose credentials and canceled runs cannot forward more requests', async t => {
  const controller = new AbortController();
  let calls = 0;
  const gateway = await openWorkerGateway({ address: '127.0.0.1', signal: controller.signal,
    grants: [{ repository: 'sample/target', repositoryId: 1, token: 'synthetic-sensitive-key',
      expiresAt: new Date(Date.now() + 60000).toISOString(), permissions: { contents: 'write' } }],
    model: { respond: async () => { calls++; throw Error('synthetic-sensitive-key'); } },
  });
  t.after(() => gateway.close());
  const headers = { authorization: `Bearer ${gateway.token}` };
  const response = await fetch(`${gateway.endpoint}/v1/responses`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('sensitive-key'));
  controller.abort();
  assert.equal((await fetch(`${gateway.endpoint}/v1/responses`, { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal(calls, 1);
});
