import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWorkerBundle, createGuestStager } from '../src/guest-stage.js';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import type { ExecutionContext } from '../src/local-coordinator.js';
import { workloadDigest } from '../src/workload-identity.js';

test('staging binds controller-selected source bytes and rejects a changed bundle before guest mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'staged-source-'));
  try {
    const path = join(root, 'source.bundle'); writeFileSync(path, 'trusted-source');
    const sha256 = createHash('sha256').update('trusted-source').digest('hex');
    const records = new Map(); let calls = 0;
    const context = { attemptId: 'attempt', task: { id: 'task', input: JSON.stringify({ role: { kind: 'code' }, sourceBundle: { sha256: 'untrusted' } }) },
      record: (key: string) => records.get(key), checkpoint: (key: string, value: unknown) => records.set(key, value) } as unknown as ExecutionContext;
    const stage = createGuestStager(buildWorkerBundle(), 'a'.repeat(40), async (_manifest, _command, input) => {
      calls++; const payload = JSON.parse(String(input));
      const envelope = JSON.parse(Buffer.from(payload.files['attempt.json'], 'base64').toString());
      assert.deepEqual(envelope.input.sourceBundle, { sha256, size: 14 });
      assert.equal(Buffer.from(payload.files['source.bundle'], 'base64').toString(), 'trusted-source');
      assert.equal(envelope.workloadDigest, workloadDigest(envelope.input, envelope.bundleDigest, 'a'.repeat(40)));
      return JSON.stringify({ files: Object.keys(payload.files).length, sha256: createHash('sha256').update(canonicalJson(payload.files)).digest('hex') });
    }, async () => ({ path, sha256 }));
    await stage(context, { manifestPath: '/owned' }); assert.equal(calls, 1);
    records.clear(); writeFileSync(path, 'changed-source');
    await assert.rejects(stage(context, { manifestPath: '/owned' }), /changed/); assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('built worker loads from an isolated bundle with no checkout or installed parent dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-bundle-'));
  try {
    const bundle = buildWorkerBundle();
    for (const [path, value] of Object.entries(bundle.files)) {
      const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(value, 'base64'));
      assert.ok(!path.includes('/.git/') && !path.includes('auth.json'));
      assert.doesNotMatch(path, /node_modules\/@intelligent-iterations\/ii-agent-runtime\/(example|test|scripts|\.factory)\//);
    }
    const url = pathToFileURL(join(root, 'dist/worker.js')).href;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(url)}); if(typeof m.runWorker!=='function')process.exit(1); console.log('loaded');`], { cwd: root, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.stdout.trim(), 'loaded');
  } finally { rmSync(root, { recursive: true }); }
});

test('staging snapshots task identity, verifies guest bytes and refuses repeat side effects', async () => {
  const bundle = buildWorkerBundle(); const records = new Map<string, unknown>(); let calls = 0;
  const context = { attemptId: 'attempt', task: { id: 'task', input: JSON.stringify({ task: 'Research' }) },
    record: (key: string) => records.get(key) ?? null, checkpoint: (key: string, value: unknown) => { records.set(key, value); } } as ExecutionContext;
  const stage = createGuestStager(bundle, 'a'.repeat(40), async (_manifest, command, input) => {
    calls++; assert.ok(records.has('workerStaging')); assert.deepEqual(command.slice(0, 3), ['sudo', '-n', 'python3']);
    const payload = JSON.parse(String(input)); const envelope = JSON.parse(Buffer.from(payload.files['attempt.json'], 'base64').toString());
    assert.equal(envelope.input.attemptId, 'attempt'); assert.equal(envelope.input.executionId, 'task');
    assert.equal(envelope.bundleDigest, bundle.sha256);
    assert.equal(envelope.workloadDigest, workloadDigest(envelope.input, bundle.sha256, 'a'.repeat(40)));
    assert.equal((records.get('workerStaging') as { workloadDigest: string }).workloadDigest, envelope.workloadDigest);
    return JSON.stringify({ files: Object.keys(payload.files).length, sha256: createHash('sha256').update(canonicalJson(payload.files)).digest('hex') });
  });
  await stage(context, { manifestPath: '/manifest' });
  await assert.rejects(stage(context, { manifestPath: '/manifest' }), /already attempted/);
  assert.equal(calls, 1);
});

test('changed bundle or guest receipt is rejected', async () => {
  const bundle = buildWorkerBundle();
  assert.throws(() => createGuestStager({ ...bundle, sha256: 'b'.repeat(64) }, 'a'.repeat(40)), /Invalid worker bundle/);
  const records = new Map<string, unknown>();
  const context = { attemptId: 'attempt', task: { id: 'task', input: '{}' }, record: (key: string) => records.get(key) ?? null,
    checkpoint: (key: string, value: unknown) => { records.set(key, value); } } as ExecutionContext;
  await assert.rejects(createGuestStager(bundle, 'a'.repeat(40), async () => '{"files":0,"sha256":"wrong"}')(context, { manifestPath: '/manifest' }), /unconfirmed/);
  assert.equal((records.get('workerStaging') as any).state, 'started');
});
