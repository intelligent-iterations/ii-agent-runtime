import { createFactoryTelemetry as createTelemetryCollector } from '../src/telemetry.js';
import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTartFiles, type executeTartGuest } from '@intelligent-iterations/ii-agent-runtime';
import { createGuestRetainer } from '../src/guest-retain.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-retention-')));
  const guest = join(root, 'guest'); const output = join(root, 'output'); mkdirSync(guest); mkdirSync(output); mkdirSync(join(guest, 'workspace'));
  const setup = { schemaVersion: 1, id: 'worker', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['report.md'] } };
  const records = new Map<string, unknown>();
  const context = { attemptId: 'attempt', task: { id: 'task', input: JSON.stringify({ role: { setup } }) }, record: (key: string) => records.get(key) ?? null,
    checkpoint: (key: string, value: unknown) => { records.set(key, structuredClone(value)); } } as ExecutionContext;
  const collector = createTelemetryCollector({ database: join(guest, 'telemetry.sqlite'), setup, executionId: 'task', attemptId: 'attempt' });
  await collector.publish({ source: 'codex', kind: 'transcript', eventType: 'codex.exec.event', payload: { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } } });
  await collector.publish({ source: 'agent', kind: 'hook', eventType: 'worker.finished', payload: { state: 'completed' } }); collector.close();
  writeFileSync(join(guest, 'workspace/report.md'), 'Report');
  const result = { schemaVersion: 1, executionId: 'task', attemptId: 'attempt', state: 'completed', telemetryComplete: true, observedUsage: true, outputGaps: [],
    artifacts: [{ path: 'report.md', size: 6, sha256: createHash('sha256').update('Report').digest('hex') }] };
  writeFileSync(join(guest, 'result.json'), JSON.stringify(result));
  const execute: typeof executeTartGuest = async (_manifest, command, input) => new Promise((resolve, reject) => {
    const child = execFile('python3', command.slice(3), { maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin!.end(input);
  });
  let captures = 0;
  const retain = createGuestRetainer(output, async (manifest, options) => {
    captures++; return captureTartFiles(manifest, { ...options, root: options.root.endsWith('/workspace') ? join(guest, 'workspace') : guest }, execute);
  });
  return { root, guest, records, context, retain, result, captures: () => captures, close() { rmSync(root, { recursive: true }); } };
}

test('retains verified output and correlated telemetry; replay works after guest deletion', async () => {
  const f = await fixture();
  try {
    const retained = await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' });
    assert.equal(retained.files.length, 3);
    rmSync(f.guest, { recursive: true });
    assert.deepEqual(await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' }), retained);
    assert.equal(f.captures(), 2);
    assert.equal(readFileSync(retained.files.find(file => file.path === 'report.md')!.localPath, 'utf8'), 'Report');
  } finally { f.close(); }
});

test('identity mismatch, missing declared artifacts and changed bytes cannot be accepted', async () => {
  for (const kind of ['identity', 'missing', 'changed']) {
    const f = await fixture();
    try {
      if (kind === 'identity') f.result.attemptId = 'other';
      if (kind === 'missing') f.result.artifacts = [];
      if (kind === 'changed') writeFileSync(join(f.guest, 'workspace/report.md'), 'Changed');
      writeFileSync(join(f.guest, 'result.json'), JSON.stringify(f.result));
      await assert.rejects(f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' }));
      assert.equal(f.records.has('retainedAttempt'), false);
    } finally { f.close(); }
  }
});

test('retained artifact tampering is detected instead of trusting an old checkpoint', async () => {
  const f = await fixture();
  try {
    const retained = await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' });
    writeFileSync(retained.files[0]!.localPath, 'tampered');
    await assert.rejects(f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' }), /changed/);
  } finally { f.close(); }
});

test('result workload binding must match staged identity before outputs can be trusted', async () => {
  for (const conclusion of ['success', 'failure']) {
    const f = await fixture();
    try {
      f.records.set('workerStaging', { workloadDigest: 'sha256:' + 'a'.repeat(64) });
      writeFileSync(join(f.guest, 'result.json'), JSON.stringify({ ...f.result, workloadDigest: 'sha256:' + 'b'.repeat(64) }));
      if (conclusion === 'success') await assert.rejects(f.retain(f.context, { manifestPath: 'manifest' }, { conclusion }), /identity mismatch/);
      else {
        const retained = await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion });
        assert.ok('interrupted' in retained); assert.equal(retained.sealedManifest, false);
        assert.ok(!retained.files.some(file => file.path === 'report.md'));
      }
    } finally { f.close(); }
  }
});


test('a successful coding run without an exact portable candidate cannot pass retention', async () => {
  const f = await fixture();
  try {
    const input = JSON.parse(f.context.task.input); input.role.kind = 'code'; input.baseCommit = 'a'.repeat(40);
    f.context.task.input = JSON.stringify(input);
    await assert.rejects(f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'success' }), /candidate evidence/);
    assert.equal(f.records.has('retainedAttempt'), false);
  } finally { f.close(); }
});

test('cancelled attempt retains explicit missing evidence and never exports unsealed workspace bytes', async () => {
  const f = await fixture();
  try {
    rmSync(join(f.guest, 'result.json')); rmSync(join(f.guest, 'telemetry.sqlite'));
    writeFileSync(join(f.guest, 'workspace/report.md'), 'unsealed synthetic credential');
    const result = await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'cancelled' });
    assert.ok('interrupted' in result); assert.equal(result.sealedManifest, false);
    assert.equal(result.files.length, 0); assert.deepEqual(result.outputGaps, ['report.md']);
    assert.ok(result.missingMetadata.includes('result.json'));
    rmSync(f.guest, { recursive: true });
    assert.deepEqual(await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'cancelled' }), result);
  } finally { f.close(); }
});

test('failed attempt retains only hash-verified sealed outputs and partial telemetry without claiming success', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.guest, 'telemetry.sqlite-wal'), 'partial journal');
    const result = await f.retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'failure' });
    assert.ok('interrupted' in result); assert.equal(result.sealedManifest, true);
    assert.deepEqual(result.outputGaps, []); assert.ok(result.files.some(file => file.path === 'report.md'));
    assert.ok(result.files.some(file => file.path === 'telemetry.sqlite-wal'));
  } finally { f.close(); }
});

test('confirmed absence does not excuse an unavailable guest transport', async () => {
  const f = await fixture();
  try {
    const output = join(f.root, 'unavailable'); mkdirSync(output);
    const retain = createGuestRetainer(output, async () => { throw Error('Guest unavailable'); });
    await assert.rejects(retain(f.context, { manifestPath: 'manifest' }, { conclusion: 'cancelled' }), /Guest unavailable/);
    assert.equal(f.records.has('retainedAttempt'), false);
  } finally { f.close(); }
});
