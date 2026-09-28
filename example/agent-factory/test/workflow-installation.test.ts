import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';
import { installFactoryWorkflows, type WorkflowInstallationTransport } from '../src/workflow-installation.js';

function fixture() {
  const setup = parseSetup({ schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: 'registry.example/worker@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/factory', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } });
  const files = new Map<string, string>();
  const calls: { method: string; path: string; body: any }[] = [];
  let head = 'a'.repeat(40); let pinned: string | undefined; let pending: any[] = [];
  const transport: WorkflowInstallationTransport = { async request(method, path, body) {
    calls.push({ method, path, body });
    const route = path.replace('/repos/org/factory', '');
    const ok = (body: unknown) => ({ status: 200, body });
    if (method === 'GET' && route === '') return ok({ private: true, default_branch: 'dev' });
    if (method === 'GET' && route === '/git/ref/heads/dev') return ok({ object: { sha: head } });
    if (route.startsWith('/contents/')) {
      const name = route.slice('/contents/'.length).split('?')[0]!;
      return files.has(name) ? ok({ type: 'file', encoding: 'base64', content: Buffer.from(files.get(name)!).toString('base64') }) : { status: 404, body: {} };
    }
    if (method === 'GET' && route.startsWith('/git/commits/')) return ok({ tree: { sha: 'b'.repeat(40) } });
    if (method === 'POST' && route === '/git/trees') { pending = (body as any).tree; return ok({ sha: 'c'.repeat(40) }); }
    if (method === 'POST' && route === '/git/commits') return ok({ sha: 'd'.repeat(40) });
    if (method === 'PATCH') {
      assert.equal((body as any).force, false); head = (body as any).sha;
      for (const file of pending) files.set(file.path, file.content);
      return ok({});
    }
    if (method === 'GET' && route.startsWith('/git/ref/tags/')) return pinned ? ok({ object: { sha: pinned, type: 'commit' } }) : { status: 404, body: {} };
    if (method === 'POST' && route === '/git/refs') { pinned = (body as any).sha; return ok({}); }
    if (route.startsWith('/actions/workflows/')) return ok({ id: route.includes('codex') ? 1 : 2, state: 'active' });
    throw Error(`Unexpected request ${method} ${route}`);
  } };
  return { files, calls, options: { repository: 'org/factory', setup, transport }, corruptPin() { pinned = 'e'.repeat(40); } };
}

test('setup installs only its self-hosted workflows, pins them and discovers IDs; reruns do not write', async () => {
  const f = fixture();
  const result = await installFactoryWorkflows(f.options);
  assert.equal(result.workerWorkflow.id, 1); assert.equal(result.verificationWorkflow.id, 2);
  assert.equal(result.workerWorkflow.commit, 'd'.repeat(40));
  assert.equal(result.workerWorkflow.ref, 'factory-workflows-' + 'd'.repeat(40));
  assert.equal(f.files.size, 2);
  for (const content of f.files.values()) { assert.match(content, /runs-on: \[self-hosted,/); assert.doesNotMatch(content, /upload-artifact|actions\/cache|ubuntu-latest/); }
  assert.doesNotMatch(f.files.get('.github/workflows/factory-verification.yml')!, /secrets\[/);
  const writes = f.calls.filter(c => c.method !== 'GET').length;
  assert.deepEqual(await installFactoryWorkflows(f.options), result);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, writes);
});

test('setup refuses to overwrite unrelated workflow contents or adopt a changed pin', async () => {
  const f = fixture(); f.files.set('.github/workflows/factory-codex.yml', 'custom workflow');
  await assert.rejects(installFactoryWorkflows(f.options), /differs/);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  f.files.clear(); await installFactoryWorkflows(f.options); f.corruptPin();
  await assert.rejects(installFactoryWorkflows(f.options), /pin conflicts/);
});
