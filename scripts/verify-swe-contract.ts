/** Execute the pinned upstream prediction loader, without importing its evaluation stack. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSweBenchEvaluation } from '../src/swe-bench.js';
const source = process.argv[2];
if (!source) throw Error('Provide swebench/harness/utils.py from revision 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e');
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), 'c22f38fdd4ffd34301da7f837b82926cf261d81ca0387d92dd2990b393517c79');
const root = mkdtempSync(join(tmpdir(), 'swe-native-contract-'));
try {
  const evaluation = prepareSweBenchEvaluation({ executionId: 'execution', attemptId: 'attempt', setupDigest: 'sha256:' + 'a'.repeat(64),
    dataset: 'SWE-bench/SWE-bench_Verified', split: 'test', datasetRevision: 'b'.repeat(40), evaluatorRevision: '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e',
    instanceId: 'example__repo-1', model: 'contract-fixture', patch: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n' });
  const path = join(root, 'predictions.jsonl'); writeFileSync(path, evaluation.predictionsJsonl, { mode: 0o600 });
  const result = execFileSync(process.env.PYTHON ?? 'python3', ['-c', `import ast,json,sys
tree=ast.parse(open(sys.argv[1]).read())
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='get_predictions_from_file')
scope={'json':json}
exec(compile(ast.Module(body=[function],type_ignores=[]),sys.argv[1],'exec'),scope)
print(json.dumps(scope['get_predictions_from_file'](sys.argv[2],'unused','test')))
`, source, path], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result), [JSON.parse(evaluation.predictionsJsonl)]);
  console.log('Pinned upstream JSONL prediction loader preserved instance, model and patch. No evaluator workload executed.');
} finally { rmSync(root, { recursive: true, force: true }); }
