import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workloadDigest } from '../src/workload-identity.js';
import { workerMain } from '../src/worker.js';

const bundle = 'a'.repeat(64); const commit = 'b'.repeat(40);
const task = { task: 'Fix the parser', repository: 'org/repo', baseCommit: 'c'.repeat(40), role: { kind: 'code', model: 'model', instructions: 'Be precise', setup: { secrets: [{ key: 'TOKEN' }] } } };
test('workload identity covers task, role, model, source, secret references, worker and workflow but excludes attempt IDs', () => {
  const digest = workloadDigest(task, bundle, commit);
  assert.equal(workloadDigest({ ...task, executionId: 'different', attemptId: 'retry' }, bundle, commit), digest);
  for (const changed of [{ ...task, task: 'Another task' }, { ...task, repository: 'org/other' }, { ...task, baseCommit: 'd'.repeat(40) },
    { ...task, role: { ...task.role, model: 'other' } }, { ...task, role: { ...task.role, instructions: 'Different' } },
    { ...task, role: { ...task.role, setup: { secrets: [{ key: 'OTHER' }] } } }]) assert.notEqual(workloadDigest(changed, bundle, commit), digest);
  assert.notEqual(workloadDigest(task, 'e'.repeat(64), commit), digest);
  assert.notEqual(workloadDigest(task, bundle, 'f'.repeat(40)), digest);
});
test('changed staged input is rejected before creating a worker directory or invoking a harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workload-binding-'));
  try {
    const input = { ...task, executionId: 'execution', attemptId: 'attempt' };
    const envelope = { input, attemptId: 'attempt', bundleDigest: bundle, workflowCommit: commit, workloadDigest: workloadDigest(input, bundle, commit) };
    const path = join(root, 'attempt.json'); writeFileSync(path, JSON.stringify({ ...envelope, input: { ...input, task: 'tampered' } }));
    await assert.rejects(workerMain(path, { directory: join(root, 'worker'), codexBinary: '/must-not-run' }), /workload identity mismatch/);
    assert.equal(existsSync(join(root, 'worker')), false);
    assert.ok(readFileSync(path, 'utf8').includes('tampered'));
  } finally { rmSync(root, { recursive: true }); }
});
