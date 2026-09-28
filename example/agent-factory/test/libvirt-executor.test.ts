import assert from 'node:assert/strict';
import test from 'node:test';
import { factoryLibvirtOptions } from '../src/defaults.js';
import { createLibvirtExecutor, type LibvirtInfrastructure } from '../src/tart-executor.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { LibvirtManifest, RunnerReceipt } from '@intelligent-iterations/ii-agent-runtime';

test('two Linux agents own separate VMs and runner registrations, then reconcile before deletion', async () => {
  const events: string[] = [];
  const records = [new Map<string, unknown>(), new Map<string, unknown>()];
  const setup = { schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'libvirt', options: factoryLibvirtOptions(),
      image: `factory-worker.qcow2@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } };
  const contexts = records.map((record, index): ExecutionContext => ({
    attemptId: `attempt-${index}`, task: { id: `task-${index}`, project: 'test', name: `agent-${index}`,
      input: JSON.stringify({ role: { setup }, repository: 'org/repo', prompt: `feature-${index}` }),
      digest: `digest-${index}`, state: 'running', cancelRequested: false, result: null },
    cancelled: () => false, record: key => record.get(key) ?? null,
    checkpoint: (key, value) => { record.set(key, structuredClone(value)); events.push(`${index}:record:${key}`); },
  }));
  let counter = 0;
  let intentCounter = 0;
  const runners = new Map<string, RunnerReceipt>();
  const infrastructure: LibvirtInfrastructure = {
    prepare: () => { const index = counter++; events.push(`${index}:prepare`); return { directory: `/operator/vm-${index}` } as LibvirtManifest; },
    deploy: async path => { events.push(`${path}:deploy`); return { present: true, running: false }; },
    start: async path => { events.push(`${path}:start`); },
    execute: async (path, command, input) => {
      if (command[0] === 'python3') return '';
      assert.ok(input?.toString().startsWith('jit-')); events.push(`${path}:handoff`); return '{}';
    },
    destroy: async path => { events.push(`${path}:destroy`); return { present: false, running: false }; },
    recover: async path => { events.push(`${path}:recover`); },
    runnerIntent: () => ({ schemaVersion: 1, operationId: `operation-${intentCounter++}`, repository: 'org/repo',
      name: 'owned', ownershipLabel: 'owned', groupId: 1, workFolder: '_work' }),
    registerGitHubRunner: async (_transport, intent, checkpoints, deliver) => {
      const index = runners.size; const receipt = { intent, runnerId: index + 1 };
      await checkpoints.intent(intent); await checkpoints.receipt(receipt);
      runners.set(intent.operationId, receipt); await deliver(`jit-${index}`); return receipt;
    },
    findGitHubRunner: async (_transport, intent) => {
      const receipt = runners.get(intent.operationId);
      return receipt ? { receipt, status: 'offline', busy: false } : null;
    },
    removeGitHubRunner: async (_transport, receipt) => { events.push(`${receipt.runnerId}:remove-runner`);
      runners.delete(receipt.intent.operationId); return 'removed'; },
  };
  const job = { run: async (context: ExecutionContext) => {
    events.push(`${context.attemptId}:job`); return { outcome: 'succeeded' as const, result: { retained: context.task.id } };
  }, reconcile: async (context: ExecutionContext) => { events.push(`${context.attemptId}:reconcile`); } };
  const executor = createLibvirtExecutor({ root: '/operator', binaries: { virsh: '/virsh', tofu: '/tofu', node: '/node' },
    repository: 'org/repo', transport: { request: async () => { throw Error('unexpected HTTP'); } }, checks: {} as never,
    onCleanup: async context => { events.push(`${context.attemptId}:revoke-grant`); }, job }, infrastructure);
  const results = await Promise.all(contexts.map(context => executor.execute(context)));
  assert.deepEqual(results.map(value => value.outcome), ['succeeded', 'succeeded']);
  assert.notEqual(records[0]!.get('manifestPath'), records[1]!.get('manifestPath'));
  assert.ok(events.indexOf('attempt-0:reconcile') < events.indexOf('/operator/vm-0/manifest.json:destroy'));
  assert.ok(events.indexOf('attempt-1:reconcile') < events.indexOf('/operator/vm-1/manifest.json:destroy'));
  assert.ok(events.indexOf('/operator/vm-0/manifest.json:destroy') < events.indexOf('attempt-0:revoke-grant'));
  assert.ok(events.indexOf('/operator/vm-1/manifest.json:destroy') < events.indexOf('attempt-1:revoke-grant'));
  assert.equal(runners.size, 0);
});
