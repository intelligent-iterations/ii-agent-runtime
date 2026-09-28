import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectGitHubSecret, runnerIntent, findGitHubRunner, registerGitHubRunner, removeGitHubRunner, RunnerOperationUncertain, type GitHubTransport, type RunnerIntent, type RunnerReceipt } from '../src/index.js';

function backend() {
  const rows: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let losePost = false;
  let loseDelete = false;
  let listUnavailable = false;
  let nextId = 1;
  const transport: GitHubTransport = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'GET' && path.includes('?')) {
      if (listUnavailable) return { status: 403, body: {} };
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page'));
      return { status: 200, body: { total_count: rows.length, runners: rows.slice((page - 1) * 100, page * 100) } };
    }
    if (method === 'POST') {
      const input = body as { name: string; labels: string[] };
      const runner = { id: nextId++, name: input.name, status: 'offline', busy: false, labels: input.labels.map(name => ({ name })) };
      rows.push(runner);
      if (losePost) throw new Error('synthetic-sensitive-response');
      return { status: 201, body: { runner, encoded_jit_config: 'synthetic-credential' } };
    }
    const id = Number(path.split('/').at(-1));
    const index = rows.findIndex(row => row.id === id);
    if (method === 'DELETE') {
      if (index >= 0) rows.splice(index, 1);
      if (loseDelete) throw new Error('response lost');
      return { status: 204, body: null };
    }
    return index >= 0 ? { status: 200, body: rows[index] } : { status: 404, body: {} };
  } };
  return { transport, rows, calls, faults: (fault: 'post' | 'delete' | 'list') => { losePost = fault === 'post'; loseDelete = fault === 'delete'; listUnavailable = fault === 'list'; } };
}
const saved = () => ({ intent: async (_: RunnerIntent) => {}, receipt: async (_: RunnerReceipt) => {} });

test('organization metadata requires complete inheritance and no repository override', async () => {
  const ref = { provider: 'github' as const, repository: 'example/work', organization: 'example', key: 'WORK_TOKEN' };
  const metadata = { name: 'WORK_TOKEN', updated_at: '2026-09-24T00:00:00Z' };
  for (const scenario of ['valid', 'override', 'missing', 'truncated', 'duplicate', 'denied', 'wrong-owner', 'mixed']) {
    const paths: string[] = [];
    const result = await inspectGitHubSecret({ request: async (_, path) => {
      paths.push(path);
      if (scenario === 'denied') return { status: 403, body: null };
      const inherited = path.includes('organization-secrets');
      const rows = inherited ? scenario === 'missing' ? [] : scenario === 'duplicate' ? [metadata, metadata] : [metadata] : scenario === 'override' ? [metadata] : [];
      return { status: 200, body: { total_count: rows.length + (scenario === 'truncated' ? 1 : 0), secrets: rows } };
    } }, { ...ref, ...(scenario === 'wrong-owner' ? { organization: 'other' } : {}), ...(scenario === 'mixed' ? { environment: 'production' } : {}) });
    assert.equal(result.status, scenario === 'valid' ? 'verified' : 'unknown', scenario);
    if (scenario === 'valid') assert.deepEqual(paths, ['/repos/example/work/actions/organization-secrets?per_page=100&page=1', '/repos/example/work/actions/secrets?per_page=100&page=1']);
    if (scenario === 'wrong-owner' || scenario === 'mixed') assert.equal(paths.length, 0);
  }
});

test('organization secret inventory follows pagination and rejects changing totals', async () => {
  const ref = { provider: 'github' as const, repository: 'example/work', organization: 'example', key: 'TARGET' };
  for (const changed of [false, true]) {
    const result = await inspectGitHubSecret({ request: async (_, path) => {
      if (!path.includes('organization-secrets')) return { status: 200, body: { total_count: 0, secrets: [] } };
      const second = path.endsWith('page=2');
      return { status: 200, body: { total_count: second && changed ? 102 : 101, secrets: second ? [{ name: 'TARGET', updated_at: '2026-09-24' }] : Array.from({ length: 100 }, (_, n) => ({ name: `KEY_${n}`, updated_at: '2026-09-24' })) } };
    } }, ref);
    assert.equal(result.status, changed ? 'unknown' : 'verified');
  }
});

test('secret inspection targets the exact repository/environment and retains only metadata evidence', async () => {
  const paths: string[] = [];
  const transport: GitHubTransport = { request: async (_, path) => {
    paths.push(path); return { status: 200, body: { name: 'WORK_TOKEN', updated_at: '2026-09-24T00:00:00Z', extra: 'synthetic-sensitive-value' } };
  } };
  const reference = { provider: 'github' as const, repository: 'example/work', key: 'WORK_TOKEN' };
  const a = await inspectGitHubSecret(transport, reference);
  const b = await inspectGitHubSecret(transport, { ...reference, environment: 'test/review' });
  assert.equal(a.status, 'verified'); assert.equal(b.status, 'verified'); assert.notEqual(a.evidenceId, b.evidenceId);
  assert.deepEqual(paths, ['/repos/example/work/actions/secrets/WORK_TOKEN', '/repos/example/work/environments/test%2Freview/secrets/WORK_TOKEN']);
  assert.ok(!JSON.stringify([a,b]).includes('synthetic-sensitive-value'));
});

test('hidden, missing, rate limited, unavailable and wrong-key metadata remain unknown', async () => {
  const ref = { provider: 'github' as const, repository: 'example/work', key: 'WORK_TOKEN' };
  for (const status of [401,403,404,429,500]) {
    assert.equal((await inspectGitHubSecret({ request: async () => ({ status, body: { message: 'private' } }) }, ref)).status, 'unknown');
  }
  for (const body of [null, {}, { name: 'WRONG', updated_at: '2026-01-01' }, { name: 'WORK_TOKEN', updated_at: 'invalid' }]) {
    assert.equal((await inspectGitHubSecret({ request: async () => ({ status: 200, body }) }, ref)).status, 'unknown');
  }
  assert.equal((await inspectGitHubSecret({ request: async () => { throw Error('private'); } }, ref)).status, 'unknown');
  let calls = 0;
  assert.equal((await inspectGitHubSecret({ request: async () => { calls++; throw Error(); } }, { ...ref, repository: '../escape' })).status, 'unknown');
  assert.equal(calls, 0);
});

test('intent precedes external effects; receipt precedes sensitive handoff; records contain no credentials', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' }); const sequence: string[] = [];
  let persisted: RunnerReceipt | undefined;
  const receipt = await registerGitHubRunner(b.transport, intent, {
    intent: async value => { assert.deepEqual(value, intent); assert.equal(b.calls.length,0); sequence.push('intent'); },
    receipt: async value => { persisted = value; sequence.push('receipt'); },
  }, async configuration => { assert.equal(configuration, 'synthetic-credential'); assert.ok(persisted); sequence.push('handoff'); });
  assert.deepEqual(sequence, ['intent','receipt','handoff']);
  assert.ok(!JSON.stringify(receipt).includes('synthetic-credential'));
  assert.equal(b.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal((await findGitHubRunner(b.transport, intent))?.receipt.runnerId, receipt.runnerId);
  await assert.rejects(registerGitHubRunner(b.transport, intent, saved(), async () => {}), /already exists/);
  assert.equal(b.calls.filter(c => c.method === 'POST').length, 1);
});

test('failed intent persistence has no side effect; failed receipt persistence never delivers credentials', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' });
  await assert.rejects(registerGitHubRunner(b.transport, intent, { ...saved(), intent: async () => { throw Error('disk'); } }, async () => assert.fail()), /disk/);
  assert.equal(b.calls.length, 0);
  await assert.rejects(registerGitHubRunner(b.transport, intent, { ...saved(), receipt: async () => { throw Error('disk'); } }, async () => assert.fail()), RunnerOperationUncertain);
  assert.equal(b.rows.length,1);
  assert.ok(await findGitHubRunner(b.transport, intent));
});

test('lost creation response returns uncertainty without a retry and supports reconciliation', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' }); b.faults('post');
  await assert.rejects(registerGitHubRunner(b.transport, intent, saved(), async () => assert.fail()), error => {
    assert.ok(error instanceof RunnerOperationUncertain); assert.equal(error.intent.operationId, intent.operationId);
    assert.ok(!error.message.includes('synthetic-sensitive-response')); return true;
  });
  assert.equal(b.calls.filter(c => c.method === 'POST').length,1);
  const found = await findGitHubRunner(b.transport, intent); assert.ok(found);
  assert.equal(await removeGitHubRunner(b.transport, found.receipt), 'removed');
  assert.equal(await removeGitHubRunner(b.transport, found.receipt), 'absent');
});

test('runner cleanup refuses numeric identity or ownership mismatch without deleting anything', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' });
  const receipt = await registerGitHubRunner(b.transport, intent, saved(), async () => {});
  b.rows[0]!.labels = [{ name: 'someone-else' }];
  await assert.rejects(removeGitHubRunner(b.transport, receipt), /identity mismatch/);
  assert.equal(b.calls.filter(c => c.method === 'DELETE').length, 0);
  b.rows[0]!.labels = [{ name: intent.ownershipLabel }]; b.rows[0]!.name = 'someone-else';
  await assert.rejects(removeGitHubRunner(b.transport, receipt), /identity mismatch/);
  assert.equal(b.rows.length, 1);
});

test('failed inventory is never proof of absence, including masked 404 during cleanup', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' }); b.faults('list');
  await assert.rejects(findGitHubRunner(b.transport, intent), RunnerOperationUncertain);
  await assert.rejects(removeGitHubRunner(b.transport, { intent, runnerId: 1 }), RunnerOperationUncertain);
  await assert.rejects(registerGitHubRunner(b.transport, intent, saved(), async () => assert.fail()), RunnerOperationUncertain);
  assert.equal(b.calls.filter(c => c.method !== 'GET').length, 0);
});

test('inventory reaches later pages and refuses incomplete or changing totals', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' });
  for (let id = 100; id < 200; id++) b.rows.push({ id, name: `other-${id}`, labels: [], status: 'online', busy: false });
  const receipt = await registerGitHubRunner(b.transport, intent, saved(), async () => {});
  assert.equal((await findGitHubRunner(b.transport, intent))?.receipt.runnerId, receipt.runnerId);
  const transport: GitHubTransport = { request: async () => ({ status: 200, body: { total_count: 2, runners: [] } }) };
  await assert.rejects(findGitHubRunner(transport, intent), RunnerOperationUncertain);
});

test('HTTP transport constrains origin, prevents redirects and suppresses raw error payloads', async () => {
  const { createGitHubTransport } = await import('../src/index.js');
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport = createGitHubTransport(async (url, init) => {
    calls.push({ url: String(url), init }); return new Response(JSON.stringify({ runners: [], total_count: 0 }), { status: 200 });
  });
  await transport.request('GET', '/repos/example/work/actions/runners');
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/example/work/actions/runners');
  assert.equal(calls[0]?.init?.redirect, 'manual'); assert.ok(calls[0]?.init?.signal);
  for (const path of ['//evil.example', '/repos/../escape', '/repos/a/b#fragment']) await assert.rejects(transport.request('GET',path));
  assert.equal(calls.length, 1);
  assert.throws(() => createGitHubTransport(fetch, 'http://api.github.com'));
  assert.throws(() => createGitHubTransport(fetch, 'https://user:password@api.github.com'));
  const failing = createGitHubTransport(async () => new Response('synthetic-private-payload', { status: 403 }));
  assert.deepEqual(await failing.request('GET','/repos/example/work/actions/runners'), { status: 403, body: null });
  const redirecting = createGitHubTransport(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }));
  await assert.rejects(redirecting.request('GET','/repos/example/work/actions/runners'), /remote outcome may be unknown/);
});

test('lost removal response is reconcilable and never silently retried', async () => {
  const b = backend(); const intent = runnerIntent('example/work', { groupId: 1, workFolder: '_work' });
  const receipt = await registerGitHubRunner(b.transport, intent, saved(), async () => {});
  b.faults('delete');
  await assert.rejects(removeGitHubRunner(b.transport, receipt));
  assert.equal(b.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(await removeGitHubRunner(b.transport, receipt), 'absent');
  assert.equal(b.calls.filter(call => call.method === 'DELETE').length, 1);
});
