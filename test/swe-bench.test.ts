import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSweBenchEvaluation, importSweBenchResult, type SweBenchInput } from '../src/swe-bench.js';
const input: SweBenchInput = { executionId: 'execution', attemptId: 'attempt', setupDigest: 'sha256:' + 'a'.repeat(64), dataset: 'SWE-bench/SWE-bench_Verified',
  split: 'test', datasetRevision: 'b'.repeat(40), evaluatorRevision: '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e', instanceId: 'example__repo-1', model: 'configured-model', patch: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n' };
const native = { patch_is_None: false, patch_exists: true, patch_successfully_applied: true, resolved: true, infra_failure: false };
const evaluation = prepareSweBenchEvaluation(input);
const evidence = (report: unknown) => ({ runId: evaluation.runId, predictionsSha256: evaluation.predictionsSha256, evaluatorRevision: input.evaluatorRevision, datasetRevision: input.datasetRevision, report });

test('native predictions preserve patch bytes and cache identity covers every evaluation input', () => {
  assert.deepEqual(JSON.parse(evaluation.predictionsJsonl), { instance_id: input.instanceId, model_name_or_path: input.model, model_patch: input.patch });
  for (const key of Object.keys(input) as (keyof SweBenchInput)[]) {
    const changed = { ...input, [key]: key.endsWith('Revision') ? 'c'.repeat(40) : key === 'setupDigest' ? 'sha256:' + 'c'.repeat(64) : input[key] + 'x' };
    assert.notEqual(prepareSweBenchEvaluation(changed).runId, evaluation.runId, key);
  }
});
test('native results retain details and distinguish resolution from infrastructure failure', () => {
  for (const outcome of ['resolved', 'unresolved', 'infrastructure_failure']) {
    const report = { [input.instanceId]: { ...native, resolved: outcome === 'resolved', infra_failure: outcome === 'infrastructure_failure', tests_status: { FAIL_TO_PASS: { success: ['test_one'], failure: [] } } } };
    const result = importSweBenchResult(evaluation, evidence(report));
    assert.equal(result.outcome, outcome); assert.deepEqual(result.nativeReport, report);
  }
});
test('stale, contradictory, missing and unrelated results cannot claim resolution', () => {
  for (const report of [{}, { other: native }, { [input.instanceId]: {} }, { [input.instanceId]: { ...native, resolved: 'true' } },
    { [input.instanceId]: { ...native, patch_successfully_applied: false } }, { [input.instanceId]: { ...native, infra_failure: true } }]) {
    assert.throws(() => importSweBenchResult(evaluation, evidence(report)));
  }
  for (const key of ['runId', 'predictionsSha256', 'evaluatorRevision', 'datasetRevision']) assert.throws(() => importSweBenchResult(evaluation, { ...evidence({ [input.instanceId]: native }), [key]: 'wrong' }), /binding/);
  assert.throws(() => importSweBenchResult({ ...evaluation, predictionsJsonl: '{}' }, evidence({ [input.instanceId]: native })), /binding/);
});
