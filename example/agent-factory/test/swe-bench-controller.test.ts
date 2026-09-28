import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSweBenchBenchmark, type SweBenchBenchmarkOptions } from '../src/swe-bench-controller.js';
import { sweBenchRevision, type SweBenchManifest } from '../src/swe-bench-job.js';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt } from '../src/guest-retain.js';
import type { createTartExecutor } from '../src/tart-executor.js';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-benchmark-recovery-')));
  const source = join(root, 'source'); mkdirSync(source);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' } }).trim();
  git('init'); writeFileSync(join(source, 'answer.txt'), 'before'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'); const basePath = join(root, 'base.bundle'); git('bundle', 'create', basePath, 'HEAD');
  writeFileSync(join(source, 'answer.txt'), 'after');
  const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit: base, secretValues: [] });
  const setup = { schemaVersion: 1 as const, id: 'benchmark', revision: '1', harness: { name: 'swe-bench', version: sweBenchRevision },
    deployment: { provider: 'tart' as const, image: 'registry.example/evaluator@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 4096 }, secrets: [], capture: { paths: ['receipt.json'] } };
  const instance = { instance_id: 'example__repo-1', repo: 'example/repo', base_commit: base, problem_statement: 'Fix this issue' };
  const database = join(root, 'work.sqlite'); let store = new WorkStore(database);
  const task = store.submit('benchmark', 'task', { repository: instance.repo, baseCommit: base, task: instance.problem_statement,
    role: { kind: 'code', setup: { ...setup, harness: { name: 'codex', version: '0.156.1' } } } });
  const attemptId = store.claim(task.id)!; let lostAck = false;
  const context: ExecutionContext = { task: store.get(task.id), attemptId, cancelled: () => store.get(task.id).cancelRequested,
    record: key => store.record(attemptId, key), checkpoint: (key, value) => {
      store.checkpoint(attemptId, key, value);
      if (lostAck && key === 'benchmark:finished') { lostAck = false; throw Error('lost final acknowledgement'); }
    } };
  const retained = { worker: { executionId: task.id, attemptId, candidate }, files: [{ path: candidate.bundle,
    localPath: join(source, candidate.bundle), sha256: candidate.sha256, size: candidate.size }] } as RetainedAttempt;
  let selections = 0; let launches = 0; let recoveries = 0; let crash = false; let removalFails = false; let receiptPath = '';
  const options: SweBenchBenchmarkOptions = { root, outputRoot: root, setup, repository: 'org/repo', binaries: { node: process.execPath, tofu: '/tofu', tart: '/tart' },
    transport: { request: async () => { throw Error('Unexpected provider request'); } }, checks: {} as never,
    workflow: { id: 3, ref: 'v1', commit: 'd'.repeat(40) }, dataset: { dataset: 'SWE-bench/SWE-bench_Verified', split: 'test', revision: 'b'.repeat(40), file: 'data/test.parquet', sha256: 'c'.repeat(64) },
    model: 'test-model', policyRevision: 'v1', timeoutSeconds: 60,
    instance: async () => { selections++; return { ...instance, patch: 'DO NOT COPY GOLD' }; },
    image: async () => ({ reference: 'swebench/example@sha256:' + 'e'.repeat(64), architecture: 'amd64', allowEmulation: true }),
    baseBundle: async () => ({ path: basePath, sha256: hash(readFileSync(basePath)) }) };
  function evidence(c: ExecutionContext) {
    const manifest = JSON.parse(c.task.input).benchmark as SweBenchManifest;
    assert.equal('patch' in manifest.task, false);
    assert.equal(manifest.evaluation.input.executionId, task.id);
    assert.equal(manifest.evaluation.input.attemptId, c.attemptId);
    assert.notEqual(c.attemptId, attemptId);
    assert.ok(manifest.evaluation.input.patch.includes('+after'));
    const report = { [instance.instance_id]: { patch_is_None: false, patch_exists: true, patch_successfully_applied: true, resolved: false, infra_failure: false } };
    const receipt = { runId: manifest.evaluation.runId, predictionsSha256: manifest.evaluation.predictionsSha256, evaluatorRevision: sweBenchRevision,
      datasetRevision: manifest.evaluation.input.datasetRevision, datasetSha256: manifest.datasetArtifact.sha256, image: manifest.image,
      imageId: 'sha256:' + 'f'.repeat(64), architecture: 'amd64', hostArchitecture: 'arm64', containerRemoved: true, testOutputSha256: hash('native test output'), report };
    const contents = { 'receipt.json': JSON.stringify(receipt), 'native-report.json': JSON.stringify(report), 'test-output.txt': 'native test output' };
    const files = Object.entries(contents).map(([path, bytes]) => {
      const localPath = join(root, path); writeFileSync(localPath, bytes, { flag: 'wx' });
      if (path === 'receipt.json') receiptPath = localPath;
      return { path, localPath, sha256: hash(bytes), size: Buffer.byteLength(bytes) };
    });
    c.checkpoint('evidence', { files, receipt }); c.checkpoint('workflowRetained', { conclusion: 'success' });
  }
  function removed(c: ExecutionContext) { c.checkpoint('vmRemoved', true); c.checkpoint('runnerRemoved', true); }
  const make: typeof createTartExecutor = () => ({ execute: async c => {
    launches++; c.checkpoint('manifestPath', '/owned/vm'); c.checkpoint('runnerIntent', { owned: true }); evidence(c);
    if (crash) throw Error('controller interrupted'); removed(c); return { outcome: 'succeeded', result: {} };
  }, recover: async c => { recoveries++; if (removalFails) throw Error('removal unconfirmed'); removed(c); return { outcome: 'failed', result: { interrupted: true } }; } });
  return { root, context, retained, options, make, reopen() { store.close(); store = new WorkStore(database); }, cancel() { store.requestCancel(task.id); },
    counters: () => ({ launches, recoveries, selections }), crash() { crash = true; }, failRemoval(value: boolean) { removalFails = value; },
    loseAck() { lostAck = true; }, corrupt() { writeFileSync(receiptPath, '{}'); },
    changeReceipt(key: string, value: unknown) {
      const evidence = context.record('benchmark:evidence') as { receipt: Record<string, unknown>; files: { path: string; size: number; sha256: string }[] };
      evidence.receipt[key] = value; const encoded = JSON.stringify(evidence.receipt); writeFileSync(receiptPath, encoded);
      const file = evidence.files.find(file => file.path === 'receipt.json')!; file.size = Buffer.byteLength(encoded); file.sha256 = hash(encoded);
      context.checkpoint('benchmark:evidence', evidence);
    }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('benchmark exports real candidate, stores native outcome separately from acceptance and replays after SQLite reopen', async () => {
  const f = await fixture();
  try {
    const result = await createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained);
    assert.equal(result.status, 'completed'); if (result.status === 'completed') assert.equal(result.result.outcome, 'unresolved');
    assert.equal('accepted' in result, false);
    f.reopen(); assert.deepEqual(await createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained), result);
    assert.deepEqual(f.counters(), { launches: 1, recoveries: 0, selections: 1 });
    f.corrupt(); await assert.rejects(createSweBenchBenchmark(f.options, f.make).recover(f.context), /retained benchmark|benchmark bytes/i);
  } finally { f.close(); }
});

test('interrupted evaluator retains result but cannot settle until teardown; restart never launches again', async () => {
  const f = await fixture();
  try {
    f.crash(); await assert.rejects(createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained), /interrupted/);
    f.reopen(); f.failRemoval(true);
    await assert.rejects(createSweBenchBenchmark(f.options, f.make).recover(f.context), /removal unconfirmed/);
    assert.equal(f.context.record('benchmark:finished'), null);
    f.failRemoval(false); f.reopen();
    assert.equal((await createSweBenchBenchmark(f.options, f.make).recover(f.context))?.status, 'completed');
    assert.deepEqual(f.counters(), { launches: 1, recoveries: 2, selections: 1 });
  } finally { f.close(); }
});

test('lost completion acknowledgement reuses persisted result; changed policy or parent cannot recover it', async () => {
  const f = await fixture();
  try {
    f.loseAck(); await assert.rejects(createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained), /lost final/);
    f.reopen(); assert.equal((await createSweBenchBenchmark(f.options, f.make).recover(f.context))?.status, 'completed');
    await assert.rejects(createSweBenchBenchmark({ ...f.options, policyRevision: 'v2' }, f.make).recover(f.context), /configuration/);
    await assert.rejects(createSweBenchBenchmark(f.options, f.make).recover({ ...f.context, task: { ...f.context.task, input: '{}' } }), /parent task/);
    assert.deepEqual(f.counters(), { launches: 1, recoveries: 0, selections: 1 });
  } finally { f.close(); }
});

test('cancelled benchmark cannot deploy and secret-bearing evaluator setup is rejected', async () => {
  const f = await fixture();
  try {
    f.cancel(); assert.deepEqual(await createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained), { status: 'cancelled', evaluatorAttemptId: null });
    assert.equal(await createSweBenchBenchmark(f.options, f.make).recover(f.context), null);
    assert.deepEqual(f.counters(), { launches: 0, recoveries: 0, selections: 0 });
    assert.throws(() => createSweBenchBenchmark({ ...f.options, setup: { ...f.options.setup, secrets: [{ provider: 'github', repository: 'org/repo', key: 'CODEX_KEY' }] } }, f.make), /credential-free/);
  } finally { f.close(); }
});

test('retained receipts with valid file hashes still require native input, image, dataset and log bindings', async () => {
  for (const [key, value] of [['image', 'other/image@sha256:' + 'e'.repeat(64)], ['datasetSha256', '0'.repeat(64)],
    ['predictionsSha256', '0'.repeat(64)], ['testOutputSha256', '0'.repeat(64)], ['containerRemoved', false]] as const) {
    const f = await fixture();
    try {
      await createSweBenchBenchmark(f.options, f.make).evaluate(f.context, f.retained);
      f.changeReceipt(key, value); f.reopen();
      await assert.rejects(createSweBenchBenchmark(f.options, f.make).recover(f.context), /mismatch/);
      assert.equal(f.counters().launches, 1);
    } finally { f.close(); }
  }
});

test('failed and cancelled evaluations have no score and replay their terminal result without deploying', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const f = await fixture(); let launches = 0;
    try {
      const make: typeof createTartExecutor = () => ({ execute: async c => {
        launches++; c.checkpoint('workflowRetained', { conclusion });
        return { outcome: conclusion === 'cancelled' ? 'cancelled' : 'failed', result: {} };
      }, recover: async () => { throw Error('Settled evaluation must not allocate or reconcile again'); } });
      const first = await createSweBenchBenchmark(f.options, make).evaluate(f.context, f.retained);
      assert.equal(first.status, conclusion === 'cancelled' ? 'cancelled' : 'interrupted');
      assert.equal('result' in first, false);
      f.cancel(); f.reopen();
      assert.deepEqual(await createSweBenchBenchmark(f.options, make).recover(f.context), first);
      assert.equal(launches, 1);
    } finally { f.close(); }
  }
});
