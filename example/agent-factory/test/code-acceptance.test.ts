import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeAcceptance, type CodeAcceptanceOptions } from '../src/code-acceptance.js';
import type { createTartExecutor } from '../src/tart-executor.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt } from '../src/guest-retain.js';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-acceptance-')));
  const candidatePath = join(root, 'candidate.bundle'); const basePath = join(root, 'base.bundle');
  writeFileSync(candidatePath, 'candidate'); writeFileSync(basePath, 'base');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const candidate = { baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), tree: 'c'.repeat(40), bundle: 'candidate.bundle', sha256: hash('candidate'), size: 9 };
  const retained = { worker: { candidate, executionId: 'task', attemptId: 'coding-attempt' }, files: [{ path: candidate.bundle, localPath: candidatePath, size: 9, sha256: candidate.sha256 }] } as RetainedAttempt;
  const records = new Map<string, unknown>([['manifestPath', 'coding-vm']]); let cancelled = false;
  const context = { attemptId: 'coding-attempt', task: { id: 'task', project: 'test', name: 'code', digest: 'digest', state: 'running', cancelRequested: false, result: null, input: JSON.stringify({ role: { kind: 'code' }, baseCommit: candidate.baseCommit }) },
    record: (key: string) => records.get(key) ?? null, checkpoint: (key: string, value: unknown) => records.set(key, structuredClone(value)), cancelled: () => cancelled } as ExecutionContext;
  let policies = 0;
  const options: CodeAcceptanceOptions = { root, outputRoot: root, repository: 'org/repo', binaries: { node: process.execPath, tart: '/tart', tofu: '/tofu' },
    transport: { request: async () => { throw Error('Unexpected provider call'); } }, checks: {} as never,
    workflow: { id: 7, ref: 'verification-v1', commit: 'd'.repeat(40) },
    setup: { schemaVersion: 1, id: 'verify', revision: '1', harness: { name: 'verification', version: '1' },
      deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/image@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['verification.json'] } },
    policy: async () => { policies++; return [{ id: 'check', script: 'true', interpreter: '/bin/sh', timeoutMs: 1000 }]; },
    baseBundle: async () => ({ path: basePath, sha256: hash('base') }) };
  return { options, retained, records, context, policies: () => policies, cancel: () => { cancelled = true; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('separate verification attempt snapshots policy and namespaces its resource records', async () => {
  const f = fixture(); let launches = 0;
  const make: typeof createTartExecutor = () => ({ execute: async context => {
    launches++; assert.notEqual(context.attemptId, f.context.attemptId); assert.ok(f.records.has('verification:snapshot'));
    assert.equal(JSON.parse(context.task.input).verification.attemptId, context.attemptId);
    context.checkpoint('manifestPath', 'verification-vm');
    return { outcome: 'succeeded', result: { checked: true } };
  }, recover: async () => { throw Error('Already finished; recovery must not run'); } });
  try {
    const acceptance = createCodeAcceptance(f.options, make);
    assert.equal((await acceptance.verify(f.context, f.retained)).accepted, true);
    assert.equal((await acceptance.verify(f.context, f.retained)).accepted, true);
    await acceptance.recoverVerification(f.context);
    assert.equal(launches, 1); assert.equal(f.policies(), 1);
    assert.equal(f.records.get('manifestPath'), 'coding-vm'); assert.equal(f.records.get('verification:manifestPath'), 'verification-vm');
  } finally { f.close(); }
});

test('ambiguous verification resumes cleanup without launch and preserves unresolved ownership', async () => {
  const f = fixture(); let launches = 0; let recoveries = 0; let uncertain = true;
  const make: typeof createTartExecutor = () => ({ execute: async context => {
    launches++; context.checkpoint('manifestPath', 'verification-vm'); throw Error('Controller interrupted');
  }, recover: async context => {
    recoveries++; assert.equal(context.record('manifestPath'), 'verification-vm');
    if (uncertain) throw Error('Removal unconfirmed');
    return { outcome: 'failed', result: { removed: true } };
  } });
  try {
    await assert.rejects(createCodeAcceptance(f.options, make).verify(f.context, f.retained), /interrupted/);
    const restarted = createCodeAcceptance(f.options, make);
    await assert.rejects(restarted.recoverVerification(f.context), /unconfirmed/);
    assert.equal(f.records.has('verification:finished'), false);
    uncertain = false; await restarted.recoverVerification(f.context);
    assert.equal((await restarted.verify(f.context, f.retained)).accepted, false);
    assert.equal(launches, 1); assert.equal(recoveries, 2); assert.equal(f.policies(), 1);
  } finally { f.close(); }
});

test('changed verification configuration cannot adopt an existing attempt', async () => {
  const f = fixture();
  const make: typeof createTartExecutor = () => ({ execute: async () => { throw Error('Interrupted'); }, recover: async () => { assert.fail('Configuration mismatch must block recovery'); } });
  try {
    await assert.rejects(createCodeAcceptance(f.options, make).verify(f.context, f.retained));
    const changed = createCodeAcceptance({ ...f.options, workflow: { ...f.options.workflow, commit: 'e'.repeat(40) } }, make);
    await assert.rejects(changed.recoverVerification(f.context), /configuration changed/);
  } finally { f.close(); }
});

test('verification VM inherits the selected coding profile and refuses changed profile on recovery', async () => {
  const f = fixture();
  const deployment = { provider: 'tart' as const, image: `registry.example/app@sha256:${'b'.repeat(64)}`, cpu: 4, memoryMiB: 4096 };
  let launches = 0;
  const make: typeof createTartExecutor = () => ({ execute: async context => {
    launches++;
    assert.deepEqual(JSON.parse(context.task.input).role.setup.deployment, deployment);
    throw Error('Interrupted after profile selection');
  }, recover: async () => { assert.fail('Changed profile must block recovery'); } });
  try {
    const selected = { ...f.options, setupFor: () => ({ ...f.options.setup, deployment }) };
    await assert.rejects(createCodeAcceptance(selected, make).verify(f.context, f.retained), /Interrupted/);
    assert.equal(launches, 1);
    const changed = { ...f.options, setupFor: () => ({ ...f.options.setup,
      deployment: { ...deployment, memoryMiB: 8192 } }) };
    await assert.rejects(createCodeAcceptance(changed, make).recoverVerification(f.context), /configuration changed/);
  } finally { f.close(); }
});


test('candidate from another execution or attempt is rejected before policy, deployment and accepted-result replay',async()=>{
  const f=fixture();let launches=0;
  const make:typeof createTartExecutor=()=>({execute:async()=>{launches++;return {outcome:'succeeded',result:{}};},recover:async()=>{assert.fail('No recovery expected');}});
  try{
    const acceptance=createCodeAcceptance(f.options,make);
    for(const field of ['executionId','attemptId'] as const){
      const wrong=structuredClone(f.retained);wrong.worker[field]='another';
      await assert.rejects(acceptance.verify(f.context,wrong),/execution identity mismatch/);
    }
    assert.equal(launches,0);assert.equal(f.policies(),0);assert.equal(f.records.has('verification:snapshot'),false);
    assert.equal((await acceptance.verify(f.context,f.retained)).accepted,true);
    for(const field of ['executionId','attemptId'] as const){
      const wrong=structuredClone(f.retained);wrong.worker[field]='another';
      await assert.rejects(acceptance.verify(f.context,wrong),/execution identity mismatch/);
    }
    assert.equal(launches,1);assert.equal(f.policies(),1);
  }finally{f.close();}
});
