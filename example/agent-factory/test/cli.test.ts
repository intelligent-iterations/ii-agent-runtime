import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkStore } from '../src/store.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-cli-')); const config = join(root, 'factory.json');
  const value = { project: 'example', database: 'work.sqlite', roles: { code: {
    kind: 'code', authMode: 'api-key', credentialKey: 'CODEX_KEY', instructions: 'Implement the requested change.', setup: {
      schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
      deployment: { provider: 'tart', options: factoryTartOptions(), image: `example/image@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
      secrets: [{ provider: 'github', repository: 'org/repo', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] },
    },
  } } };
  writeFileSync(config, JSON.stringify(value));
  return { root, config, value,
    async run(...args: string[]) { return JSON.parse((await promisify(execFile)(process.execPath, [cli, config, ...args], { cwd: tmpdir() })).stdout); },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}
const source = ['org/repo', 'a'.repeat(40)];

test('separate CLI processes submit idempotently, list scoped work, and inspect retry history and results', async () => {
  const f = fixture();
  try {
    const agent = await f.run('spawn', 'code-one', 'code', 'Fix code', ...source);
    assert.equal(agent.state, 'queued'); assert.deepEqual(agent.attempts, []);
    assert.equal((await f.run('spawn', 'code-one', 'code', 'Fix code', ...source)).id, agent.id);
    await assert.rejects(f.run('spawn', 'code-one', 'code', 'Conflicting task', ...source), /different inputs/);
    const store = new WorkStore(join(f.root, 'work.sqlite'));
    try {
      const first = store.claim(agent.id)!; store.finish(first, 'retry', { reason: 'runner busy' });
      const second = store.claim(agent.id)!;
      const active = await f.run('status', agent.id);
      assert.equal(active.state, 'running'); assert.deepEqual(active.attempts.map((a: { outcome: string | null }) => a.outcome), ['retry', null]);
      assert.equal(Object.hasOwn(active, 'input'), false);
      store.checkpoint(second, 'execution_error', { state: 'recovery_required', private: 'never-display' });
      const held = await f.run('status', agent.id);
      assert.equal(held.recoveryRequired, true); assert.equal(JSON.stringify(held).includes('never-display'), false);
      await assert.rejects(f.run('result', agent.id), /requires recovery/);
      assert.equal(store.get(agent.id).state, 'running');
      store.checkpoint(second, 'execution_error', null);
      const result = { accepted: true, report: { localPath: '/onprem/report.json', sha256: 'a'.repeat(64) } };
      store.finish(second, 'succeeded', result);
      assert.deepEqual(await f.run('result', agent.id, '1000'), result);
      const foreign = store.submit('other-project', 'other', {});
      assert.deepEqual((await f.run('list')).map((a: { id: string }) => a.id), [agent.id]);
      await assert.rejects(f.run('status', foreign.id), /different project/);
      await assert.rejects(f.run('cancel', foreign.id), /different project/);
      assert.equal(store.get(foreign.id).state, 'queued');
    } finally { store.close(); }
  } finally { f.close(); }
});

test('CLI wait timeout preserves work, cancellation is durable, and malformed commands do not create state', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run('spawn', 'missing-arguments'), /Usage:/);
    await assert.rejects(f.run('result', 'unknown', 'NaN'), /positive integer/);
    assert.equal(existsSync(join(f.root, 'work.sqlite')), false);
    const agent = await f.run('spawn', 'one', 'code', 'Fix code', ...source);
    await assert.rejects(f.run('result', agent.id, '1'), /timed out/);
    assert.equal((await f.run('status', agent.id)).state, 'queued');
    assert.equal((await f.run('cancel', agent.id)).state, 'cancelled');
    assert.equal((await f.run('status', agent.id)).cancelRequested, true);
    await assert.rejects(f.run('result', agent.id), /Agent cancelled/);
  } finally { f.close(); }
});

test('CLI permission inspection distinguishes current configuration from a submitted agent snapshot', async () => {
  const f = fixture();
  try {
    const agent = await f.run('spawn', 'snapshot', 'code', 'Fix code', ...source);
    const config = JSON.parse(JSON.stringify(f.value));
    config.roles.code.githubPermissions = { issues: 'read' };
    writeFileSync(f.config, JSON.stringify(config));
    const roles = await f.run('permissions');
    assert.equal(roles.code.evidence, 'declared');
    assert.equal(roles.code.secrets[0].environmentVariable, 'CODEX_KEY');
    assert.equal(roles.code.secrets[0].purpose, 'harness-auth');
    assert.deepEqual(roles.code.githubPermissions, { issues: 'read' });
    assert.equal((await f.run('permissions', agent.id)).secrets.length, 1);
    assert.deepEqual((await f.run('permissions', agent.id)).githubPermissions, {});
    const store = new WorkStore(join(f.root, 'work.sqlite'));
    try { const other = store.submit('private-project', 'private', {}); await assert.rejects(f.run('permissions', other.id), /different project/); } finally { store.close(); }
  } finally { f.close(); }
});
