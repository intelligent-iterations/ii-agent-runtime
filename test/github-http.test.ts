import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGitHubApi, GitHubError } from '../src/providers/github-http.js';

test('HTTP boundary rejects oversized bodies, redirects and request amplification without exposing credentials', async t => {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    if (req.url === '/large') { res.writeHead(200); res.end(JSON.stringify({ payload: 'x'.repeat(1000) })); }
    else if (req.url === '/redirect') { res.writeHead(302, { location: '/credential-leak' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const transport: typeof fetch = (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
  const api = createGitHubApi({ credential: () => 'synthetic-secret', fetch: transport, maxRequests: 3, maxResponseBytes: 100 });
  assert.deepEqual((await api.request('GET', '/ok')).body, { ok: true });
  await assert.rejects(api.request('GET', '/large'), error => error instanceof GitHubError && error.code === 'RESPONSE_LIMIT');
  await assert.rejects(api.request('GET', '/redirect'), error => error instanceof GitHubError && !error.message.includes('synthetic-secret'));
  await assert.rejects(api.request('GET', '/ok'), /REQUEST_LIMIT/);
  assert.equal(count, 3);
  await assert.rejects(api.request('GET', '//other.example/path'), /INVALID_PATH/);
});

test('uncertain mutation failures are never automatically retried and raw transport errors are suppressed', async () => {
  let requests = 0;
  const api = createGitHubApi({ credential: () => 'synthetic-secret', fetch: async () => {
    requests++; throw Error('credential synthetic-secret included in provider error');
  } });
  await assert.rejects(api.request('POST', '/app-manifests/code/conversions'), error => error instanceof GitHubError && error.message === 'GitHub request failed (TRANSPORT)');
  assert.equal(requests, 1);
});
