import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareSweBenchEvaluation } from '@intelligent-iterations/ii-agent-runtime';

test('native evaluator preflight binds dataset, public task, prediction, image and execution policy before Docker', () => {
  const evaluation = prepareSweBenchEvaluation({ executionId: 'execution', attemptId: 'attempt', setupDigest: 'sha256:' + 'a'.repeat(64),
    dataset: 'SWE-bench/SWE-bench_Verified', split: 'test', datasetRevision: 'b'.repeat(40),
    evaluatorRevision: '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e', instanceId: 'example__repo-1', model: 'test/model', patch: 'candidate, never gold' });
  const row = { instance_id: evaluation.input.instanceId, repo: 'example/repo', base_commit: 'c'.repeat(40),
    problem_statement: 'fix café 🐛', image: 'swebench/example:latest', patch: 'hidden gold', test_patch: 'hidden tests' };
  const manifest = { schemaVersion: 1, evaluation,
    datasetArtifact: { dataset: evaluation.input.dataset, split: 'test', revision: evaluation.input.datasetRevision,
      sha256: createHash('sha256').update('dataset bytes').digest('hex') },
    task: { repo: row.repo, base_commit: row.base_commit, problem_statement: row.problem_statement },
    image: 'swebench/example@sha256:' + 'd'.repeat(64), architecture: 'amd64', allowEmulation: false, timeoutSeconds: 60 };
  const script = fileURLToPath(new URL('../evaluators/swe-bench/run.py', import.meta.url));
  const output = execFileSync('python3', ['-I', '-c', `import copy,importlib.util,json,sys
spec=importlib.util.spec_from_file_location('evaluator',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fixture=json.load(sys.stdin); original=fixture['manifest']; rows=[fixture['row']]
instance,prediction=module.validate(original,b'dataset bytes',rows)
assert prediction['model_patch']=='candidate, never gold'
assert 'test_patch' not in prediction and 'patch' not in prediction
cases=[
 ('schemaVersion',2,'manifest'),
 ('datasetArtifact.sha256','0'*64,'bytes changed'),
 ('datasetArtifact.revision','0'*40,'binding mismatch'),
 ('datasetArtifact.dataset','another/dataset','binding mismatch'),
 ('datasetArtifact.split','dev','binding mismatch'),
 ('evaluation.runId','other','Run binding'),
 ('evaluation.predictionsSha256','0'*64,'Prediction binding'),
 ('evaluation.predictionsJsonl','{}','Prediction binding'),
 ('evaluation.input.evaluatorRevision','0'*40,'Unsupported evaluator'),
 ('task.repo','other/repo','submitted task'),
 ('task.base_commit','0'*40,'submitted task'),
 ('task.problem_statement','other task','submitted task'),
 ('image','swebench/example:latest','pin the dataset'),
 ('image','other/image@sha256:'+'d'*64,'pin the dataset'),
 ('architecture','x86','architecture policy'),
 ('allowEmulation','true','architecture policy'),
 ('timeoutSeconds',True,'timeout'),
 ('timeoutSeconds',0,'timeout'),
 ('timeoutSeconds',3601,'timeout'),
]
for path,value,message in cases:
 m=copy.deepcopy(original); target=m; keys=path.split('.')
 for key in keys[:-1]: target=target[key]
 target[keys[-1]]=value
 try: module.validate(m,b'dataset bytes',rows)
 except ValueError as error: assert message in str(error),(path,str(error))
 else: raise AssertionError(path)
for changed in [[],rows+rows]:
 try: module.validate(original,b'dataset bytes',changed)
 except ValueError as error: assert 'unique' in str(error)
 else: raise AssertionError('ambiguous dataset')
changed=copy.deepcopy(rows);changed[0]['image_assets']={'test_patch':[{'url':'https://example.com/mutable'}]}
try: module.validate(original,b'dataset bytes',changed)
except ValueError as error: assert 'Unpinned external' in str(error)
else: raise AssertionError('mutable asset')
print(json.dumps({'rejections':len(cases)+3,'candidatePatchPreserved':True}))
`, script], { input: JSON.stringify({ manifest, row }), encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(output), { rejections: 22, candidatePatchPreserved: true });
});
