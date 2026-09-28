import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore } from '../src/store.js';
import { startLocalCoordinator } from '../src/local-coordinator.js';

test('killed controller is replaced only after death; recovery removes its durable resource without relaunch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-controller-crash-'));
  const database = join(root, 'work.sqlite'); const resource = join(root, 'owned-resource');
  const store = new WorkStore(database); const task = store.submit('project', 'task', { task: 'Task' });
  const serviceUrl = new URL('../src/local-coordinator.ts', import.meta.url).href;
  const source = `import {startLocalCoordinator} from ${JSON.stringify(serviceUrl)};
    import {writeFileSync} from 'node:fs';
    await startLocalCoordinator({database:process.argv[1],project:'project',pollMs:10,execute:async context=>{
      context.checkpoint('resource',process.argv[2]);writeFileSync(process.argv[2],'created once');context.checkpoint('resourceReady',true);await new Promise(()=>{});return {outcome:'failed',result:{}};
    }});console.log('ready');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, database, resource], { stdio: ['ignore', 'pipe', 'pipe'] });
  let resumed: Awaited<ReturnType<typeof startLocalCoordinator>> | undefined;
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(Error('Coordinator did not start')), 5000))]);
    const resourceDeadline = Date.now() + 5000;
    while (true) {
      const active = store.activeAttempt(task.id);
      if (active && store.record(active, 'resourceReady') === true) break;
      if (Date.now() >= resourceDeadline) throw Error('Executor did not create its resource');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(resource, 'utf8'), 'created once');
    await assert.rejects(startLocalCoordinator({ database, project: 'project', execute: async () => { throw Error(); } }), /still be alive/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    let launches = 0; let recovered = 0;
    resumed = await startLocalCoordinator({ database, project: 'project', execute: async () => { launches++; throw Error(); }, recover: async context => {
      recovered++; assert.equal(context.record('resource'), resource); assert.ok(existsSync(resource)); rmSync(resource);
      return { outcome: 'failed', result: { resourceRemoved: true } };
    } });
    const deadline = Date.now() + 5000;
    while (store.get(task.id).state !== 'failed') {
      if (Date.now() >= deadline) throw Error('Recovery did not finish');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(launches, 0); assert.equal(recovered, 1); assert.equal(existsSync(resource), false);
    assert.equal(store.get(task.id).state, 'failed');
    assert.deepEqual(store.get(task.id).result, { resourceRemoved: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await resumed?.close(); store.close(); rmSync(root, { recursive: true });
  }
});
