import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/store.js';
import { startLocalCoordinator } from '../src/local-coordinator.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Coordinator condition timed out');
    await pause(10);
  }
}

test('local coordinator runs 128 distinct tasks with 64 concurrent attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-coordination-'));
  const database = join(root, 'tasks.sqlite');
  const store = new WorkStore(database);
  for (let index = 0; index < 128; index++) store.submit('project', `agent-${index}`, { task: `prompt-${index}`, repository: `org/repo-${index}`, secret: `KEY_${index}` });
  let active = 0; let peak = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen = new Set<string>();
  let coordinator: Awaited<ReturnType<typeof startLocalCoordinator>> | undefined;
  try {
    coordinator = await startLocalCoordinator({ database, project: 'project', maxConcurrentAgents: 64, pollMs: 10,
      execute: async context => {
        active++; peak = Math.max(peak, active); seen.add(context.task.name);
        await gate; active--;
        return { outcome: 'succeeded', result: { name: context.task.name } };
      },
    });
    await until(() => seen.size === 64);
    assert.equal(peak, 64);
    assert.equal(store.list('project').filter(task => task.state === 'queued').length, 64);
    release();
    await until(() => store.list('project').every(task => task.state === 'succeeded'));
    assert.equal(seen.size, 128);
    assert.equal(peak, 64);
    assert.equal(new Set(store.list('project').map(task => JSON.parse(task.input).repository)).size, 128);
  } finally { release(); await coordinator?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an ambiguous attempt is recovered without dispatching a second execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-recovery-'));
  const database = join(root, 'tasks.sqlite');
  const store = new WorkStore(database);
  const task = store.submit('project', 'one', { task: 'work' });
  let coordinator: Awaited<ReturnType<typeof startLocalCoordinator>> | undefined;
  try {
    coordinator = await startLocalCoordinator({ database, project: 'project', pollMs: 10,
      execute: async context => { context.checkpoint('ownedResource', 'vm-1'); throw Error('lost response'); },
    });
    await until(() => store.attempts(task.id)[0]?.recoveryRequired === true);
    await coordinator.close(); coordinator = undefined;
    let launches = 0; let recoveries = 0;
    coordinator = await startLocalCoordinator({ database, project: 'project', pollMs: 10,
      execute: async () => { launches++; throw Error('must not relaunch'); },
      recover: async context => {
        recoveries++; assert.equal(context.record('ownedResource'), 'vm-1');
        return { outcome: 'failed', result: { cleaned: true } };
      },
    });
    await until(() => store.get(task.id).state === 'failed');
    assert.equal(launches, 0);
    assert.equal(recoveries, 1);
  } finally { await coordinator?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
