import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTartExecutor, type TartInfrastructure, type FactoryJob } from '../src/tart-executor.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { DeploymentManifest, RunnerReceipt } from '@intelligent-iterations/ii-agent-runtime';

function fixture() {
  const events: string[] = [];
  const records = new Map<string, unknown>();
  let cancelled = false;
  const setup = { schemaVersion: 1, id: 'test', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['report.md'] } };
  const context: ExecutionContext = {
    attemptId: 'attempt', task: { id: 'task', project: 'test', name: 'test', input: JSON.stringify({ role: { setup } }), digest: 'digest', state: 'running', cancelRequested: false, result: null },
    cancelled: () => cancelled,
    checkpoint(key, value) { events.push(`record:${key}`); records.set(key, structuredClone(value)); },
    record: key => records.get(key) ?? null,
  };
  const intent = { schemaVersion: 1 as const, operationId: 'operation', repository: 'org/repo', name: 'owned', ownershipLabel: 'owned', groupId: 1, workFolder: '_work' };
  const receipt: RunnerReceipt = { intent, runnerId: 123 };
  let runnerPresent = true;
  const infrastructure: TartInfrastructure = {
    prepareTartDeployment: () => { events.push('prepare'); return { directory: '/operator/attempt' } as DeploymentManifest; },
    deployTart: async () => { events.push('deploy'); assert.equal(records.get('manifestPath'), '/operator/attempt/manifest.json'); return { present: true, running: false }; },
    startTartVM: async () => { events.push('start'); },
    executeTartGuest: async (_manifest, command, input) => {
      if (command[0] === 'python3') { assert.match(command[2]!, /https:\/\/api\.github\.com/); assert.match(command[2]!, /timeout=5/); events.push('ready'); return ''; }
      assert.deepEqual(command.slice(0, 3), ['sudo', '-n', 'python3']);
      events.push('handoff'); assert.equal(input, 'sensitive-jit'); assert.ok(records.has('runnerReceipt')); return '{}';
    },
    recoverDeploymentLock: async () => { events.push('recover-lock'); },
    destroyTart: async () => { events.push('destroy'); return { present: false, running: false }; },
    runnerIntent: () => intent,
    registerGitHubRunner: async (_transport, _intent, checkpoints, deliver) => {
      await checkpoints.intent(intent); events.push('register'); await checkpoints.receipt(receipt); await deliver('sensitive-jit'); return receipt;
    },
    findGitHubRunner: async () => { events.push('find'); return runnerPresent ? { receipt, status: 'offline', busy: false } : null; },
    removeGitHubRunner: async () => { events.push('remove-runner'); runnerPresent = false; return 'removed'; },
  };
  const job: FactoryJob = {
    run: async () => { events.push('job'); return { outcome: 'succeeded', result: { retained: '/operator/output' } }; },
    reconcile: async () => { events.push('reconcile'); },
  };
  const controller = () => createTartExecutor({ root: '/operator', repository: 'org/repo', binaries: { tart: '/tart', tofu: '/tofu', node: '/node' },
    transport: { request: async () => { throw Error('unexpected HTTP'); } }, checks: {} as never, job }, infrastructure);
  return { events, records, context, infrastructure, job, controller, cancel() { cancelled = true; } };
}

test('retains outcome before cleanup and checkpoints runner ownership before credential handoff', async () => {
  const f = fixture();
  const result = await f.controller().execute(f.context);
  assert.equal(result.outcome, 'succeeded');
  assert.ok(f.events.indexOf('record:runnerIntent') < f.events.indexOf('register'));
  assert.ok(f.events.indexOf('record:retainedOutcome') < f.events.indexOf('reconcile'));
  assert.ok(f.events.indexOf('reconcile') < f.events.indexOf('remove-runner'));
  assert.ok(f.events.indexOf('remove-runner') < f.events.indexOf('destroy'));
  assert.equal(f.records.get('vmRemoved'), true);
  assert.ok(!JSON.stringify([...f.records]).includes('sensitive-jit'));
});

test('a retained job can release its owned VM before independent acceptance without double-removing the runner', async () => {
  const f = fixture();
  f.job.run = async (_context, _resource, release) => {
    f.events.push('retained');
    await release();
    assert.equal(f.records.get('runnerRemoved'), true);
    assert.equal(f.records.get('vmRemoved'), true);
    f.events.push('acceptance');
    return { outcome: 'succeeded', result: { accepted: true } };
  };
  assert.equal((await f.controller().execute(f.context)).outcome, 'succeeded');
  assert.ok(f.events.indexOf('destroy') < f.events.indexOf('acceptance'));
  assert.equal(f.events.filter(event => event === 'remove-runner').length, 1);
});

test('lost runner registration response reconciles its saved intent before deleting the VM', async () => {
  const f = fixture();
  f.infrastructure.registerGitHubRunner = async (_transport, intent, checkpoints) => {
    await checkpoints.intent(intent); throw Error('sensitive-jit');
  };
  const result = await f.controller().execute(f.context);
  assert.equal(result.outcome, 'failed');
  assert.ok(f.events.includes('find'));
  assert.ok(f.events.includes('remove-runner'));
  assert.ok(f.events.includes('destroy'));
  assert.ok(!f.events.includes('job'));
  assert.ok(!JSON.stringify([...f.records]).includes('sensitive-jit'));
});

test('uncertain job reconciliation keeps infrastructure intact and recovery never launches again', async () => {
  const f = fixture();
  f.job.reconcile = async () => { throw Error('dispatch outcome unknown'); };
  await assert.rejects(f.controller().execute(f.context), /dispatch outcome unknown/);
  assert.ok(!f.events.includes('destroy'));
  assert.ok(!f.events.includes('remove-runner'));
  await assert.rejects(f.controller().execute(f.context), /require recovery/);
  f.job.reconcile = async () => { f.events.push('reconcile'); };
  assert.equal((await f.controller().recover(f.context)).outcome, 'succeeded');
  assert.equal(f.events.filter(event => event === 'deploy').length, 1);
  assert.equal(f.events.filter(event => event === 'job').length, 1);
});

test('unconfirmed removal cannot become terminal success', async () => {
  const f = fixture();
  f.infrastructure.destroyTart = async () => ({ present: true, running: true });
  await assert.rejects(f.controller().execute(f.context), /removal is unconfirmed/);
  assert.equal(f.records.has('vmRemoved'), false);
  assert.equal((f.records.get('retainedOutcome') as { outcome: string }).outcome, 'succeeded');
});

test('cancellation before allocation creates no resources; cancellation after deploy cleans without a job', async () => {
  const first = fixture(); first.cancel();
  assert.equal((await first.controller().execute(first.context)).outcome, 'cancelled');
  assert.deepEqual(first.events, []);
  const second = fixture();
  second.infrastructure.deployTart = async () => { second.cancel(); return { present: true, running: false }; };
  assert.equal((await second.controller().execute(second.context)).outcome, 'cancelled');
  assert.ok(second.events.includes('destroy'));
  assert.ok(!second.events.includes('start'));
  assert.ok(!second.events.includes('job'));
});

test('partial VM deployment failure still reconciles and removes the owned resource', async () => {
  const f = fixture();
  f.infrastructure.deployTart = async () => { throw Error('partial clone'); };
  assert.equal((await f.controller().execute(f.context)).outcome, 'failed');
  assert.ok(f.events.includes('destroy'));
  assert.ok(!f.events.includes('register'));
});


test('recovery refuses provider cleanup until runtime confirms the old command owner is gone', async () => {
  const f = fixture();
  f.records.set('manifestPath', '/operator/attempt/manifest.json');
  f.infrastructure.recoverDeploymentLock = async () => { throw Error('Command group may still be alive'); };
  await assert.rejects(f.controller().recover(f.context), /still be alive/);
  assert.equal(f.events.length, 0);
  f.infrastructure.recoverDeploymentLock = async () => { f.events.push('recover-lock'); };
  assert.equal((await f.controller().recover(f.context)).outcome, 'failed');
  assert.ok(f.events.indexOf('recover-lock') < f.events.indexOf('reconcile'));
  assert.ok(f.events.includes('destroy'));
  assert.ok(!f.events.includes('deploy'));
});


test('failure evidence identifies its phase without retaining provider error contents', async () => {
  for (const [method, phase] of [
    ['prepareTartDeployment', 'prepare'], ['deployTart', 'deploy'],
    ['startTartVM', 'start'], ['registerGitHubRunner', 'runner-registration'],
  ] as const) {
    const f = fixture();
    Object.assign(f.infrastructure, { [method]: () => { throw Error('credential-in-provider-error'); } });
    const result = await f.controller().execute(f.context);
    assert.deepEqual(result, { outcome: 'failed', result: { reason: 'execution_failed', phase } });
    assert.equal(f.records.get('executionPhase'), phase);
    assert.equal(JSON.stringify([...f.records]).includes('credential-in-provider-error'), false);
    assert.equal(f.events.includes('destroy'), phase !== 'prepare');
  }
  const handoff = fixture();
  handoff.infrastructure.executeTartGuest = async (_manifest, command) => {
    if (command[0] === 'python3') return '';
    throw Error('credential-in-handoff-error');
  };
  assert.deepEqual(await handoff.controller().execute(handoff.context),
    { outcome: 'failed', result: { reason: 'execution_failed', phase: 'runner-start' } });
  assert.equal(JSON.stringify([...handoff.records]).includes('credential-in-handoff-error'), false);
  assert.equal(handoff.records.get('runnerRemoved'), true);
  assert.equal(handoff.records.get('vmRemoved'), true);
  const f = fixture();
  f.job.run = async () => { throw Error('credential-in-job-error'); };
  const result = await f.controller().execute(f.context);
  assert.deepEqual(result, { outcome: 'failed', result: { reason: 'execution_failed', phase: 'job' } });
  assert.equal(JSON.stringify([...f.records]).includes('credential-in-job-error'), false);
  assert.equal(f.records.get('runnerRemoved'), true);
  assert.equal(f.records.get('vmRemoved'), true);
});


test('a failed guest network probe cannot register a runner or dispatch work', async () => {
  const f = fixture();
  f.infrastructure.executeTartGuest = async () => { f.cancel(); throw Error('network unavailable'); };
  assert.deepEqual(await f.controller().execute(f.context),
    { outcome: 'failed', result: { reason: 'execution_failed', phase: 'guest-readiness' } });
  assert.equal(f.events.includes('register'), false);
  assert.equal(f.events.includes('job'), false);
  assert.equal(f.records.get('vmRemoved'), true);
});
