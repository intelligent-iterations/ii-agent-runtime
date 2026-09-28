/** Native grading compatibility. Synthetic logs, not benchmark execution or a model score. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSweBenchResult, prepareSweBenchEvaluation } from '@intelligent-iterations/ii-agent-runtime';

const revision = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e';
const [checkout, python, evidencePath] = process.argv.slice(2);
if (!checkout || !python || !evidencePath) throw Error('Usage: verify-swe-grading.ts pinned-upstream-checkout python new-evidence-path');
const upstream = realpathSync(checkout);
const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), revision);
assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Upstream checkout must be clean');
const directory = mkdtempSync(join(tmpdir(), 'factory-swe-grading-'));
try {
  const evaluation = prepareSweBenchEvaluation({ executionId: 'grading-contract', attemptId: 'attempt', setupDigest: 'sha256:' + 'a'.repeat(64),
    dataset: 'synthetic/contract', split: 'test', datasetRevision: 'b'.repeat(40), evaluatorRevision: revision,
    instanceId: 'example__repo-1', model: 'contract-fixture', patch: 'synthetic patch; no candidate execution' });
  const predictionsPath = join(directory, 'predictions.jsonl');
  writeFileSync(predictionsPath, evaluation.predictionsJsonl, { mode: 0o600, flag: 'wx' });
  const output = execFileSync(python, ['-I', fileURLToPath(new URL('./swe-native-grading.py', import.meta.url)), upstream, directory, predictionsPath],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory },
      encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const cases = JSON.parse(output) as { name: string; expected: string; report: unknown }[];
  assert.deepEqual(cases.map(c => c.name), ['resolved', 'unfixed', 'regression', 'skipped_fix', 'skipped_stable', 'missing_fix', 'false_success', 'no_tests', 'environment']);
  const results = cases.map(({ name, expected, report }) => {
    const evidence = { runId: evaluation.runId, predictionsSha256: evaluation.predictionsSha256,
      evaluatorRevision: revision, datasetRevision: evaluation.input.datasetRevision, report };
    const result = importSweBenchResult(evaluation, evidence);
    assert.equal(result.outcome, expected, name);
    assert.deepEqual(result.nativeReport, report, 'Native details must be preserved');
    for (const key of ['runId', 'predictionsSha256', 'evaluatorRevision', 'datasetRevision'] as const) {
      assert.throws(() => importSweBenchResult(evaluation, { ...evidence, [key]: 'wrong' }), /binding mismatch/);
    }
    return { name, result, log: readFileSync(join(directory, name + '.log'), 'utf8') };
  });
  writeFileSync(evidencePath, JSON.stringify({ kind: 'synthetic-log-native-grading-contract', evaluatorRevision: revision,
    pythonVersion: execFileSync(python, ['--version'], { encoding: 'utf8' }).trim(),
    dependencies: execFileSync(python, ['-I', '-m', 'pip', 'freeze'], { encoding: 'utf8', timeout: 30000 }).trim().split('\n'),
    modelCalls: 0, candidateExecutions: 0, evaluation, results }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Nine native grading cases imported correctly; four invocation bindings rejected per case. No benchmark workload executed.');
} finally { rmSync(directory, { recursive: true, force: true }); }
