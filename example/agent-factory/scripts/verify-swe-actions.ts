import { factoryTartOptions } from '../src/defaults.js';
/** Real native evaluator on a fresh Actions VM. The supplied prediction is a controlled fixture, not an agent score. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, captureTartFiles, createGitHubTransport, findGitHubRunner, importSweBenchResult, inspectTartDeployment,
  prepareSweBenchEvaluation, setupDigest, parseSetup, type RunnerIntent, type SweBenchEvaluation } from '@intelligent-iterations/ii-agent-runtime';
import { createTartExecutor } from '../src/tart-executor.js';
import { createGitHubJob } from '../src/github-job.js';
import { createGuestStager } from '../src/guest-stage.js';
import { installVerificationEntry } from '../src/code-acceptance.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

const [repository, image, workflowId, ref, commit, manifestPath, directory, expected = 'unresolved'] = process.argv.slice(2);
if (!repository || !image || !workflowId || !ref || !commit || !manifestPath || !directory || !['resolved', 'unresolved', 'infrastructure_failure'].includes(expected)) throw Error('Usage: verify-swe-actions.ts repository image workflow-id ref commit evaluator-manifest new-directory [expected-native-outcome]');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let evaluation = manifest.evaluation as SweBenchEvaluation;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const transport = createGitHubTransport((url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }));
const store = new WorkStore(join(root, 'work.sqlite'));
const setup = { schemaVersion: 1, id: 'benchmark', revision: '1', harness: { name: 'swe-bench', version: evaluation.input.evaluatorRevision },
  deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 4096 }, secrets: [], capture: { paths: ['receipt.json', 'preparation.log', 'test-output.txt', 'dependencies.txt', 'native-instance.log', 'native-report.json'] } };
const task = store.submit('native-evaluator-proof', 'candidate', { role: { kind: 'code', setup } });
const attemptId = store.claim(task.id)!;
// This driver owns a synthetic control prediction, so bind it to this fresh proof attempt.
evaluation = prepareSweBenchEvaluation({ ...evaluation.input, executionId: task.id, attemptId, setupDigest: setupDigest(parseSetup(setup)) });
manifest.evaluation = evaluation;
writeFileSync(join(root, 'evaluator-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
const context: ExecutionContext = { task: store.get(task.id), attemptId, cancelled: () => store.get(task.id).cancelRequested,
  record: key => store.record(attemptId, key), checkpoint: (key, value) => {
    store.checkpoint(attemptId, key, value);
    if (['executionPhase', 'workflowRunId', 'vmRemoved', 'runnerRemoved'].includes(key)) console.log(key, JSON.stringify(value));
  } };
const shell = `#!/bin/sh
set -eu
mkdir -m 700 /opt/factory/benchmark-proof
exec > /opt/factory/benchmark-proof/preparation.log 2>&1
retain_native() {
python3 - <<'PY'
from pathlib import Path
root=Path('/opt/factory/evaluation')
target=Path('/opt/factory/benchmark-proof')
for name,out in [('receipt.json','receipt.json')]:
 if (root/name).is_file(): (target/out).write_bytes((root/name).read_bytes())
for name,out in [('test_output.txt','test-output.txt'),('run_instance.log','native-instance.log'),('report.json','native-report.json')]:
 files=list((root/'logs/evaluation').glob('*/*/*/'+name))
 if len(files)==1: (target/out).write_bytes(files[0].read_bytes())
PY
}
trap retain_native EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends docker.io docker-cli qemu-user-static binfmt-support python3-venv
systemctl start docker
docker version
systemctl restart systemd-binfmt
test -f /proc/sys/fs/binfmt_misc/qemu-x86_64
cat /proc/sys/fs/binfmt_misc/qemu-x86_64
git clone --no-checkout https://github.com/SWE-bench/SWE-bench.git /opt/factory/swe-upstream
git -C /opt/factory/swe-upstream checkout --detach 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e
python3 -m venv /opt/factory/swe-python
/opt/factory/swe-python/bin/pip install /opt/factory/swe-upstream
/opt/factory/swe-python/bin/pip freeze > /opt/factory/benchmark-proof/dependencies.txt
python3 - <<'PY'
import json,urllib.request,hashlib
m=json.load(open('/opt/factory/workload/manifest.json'))
a=m['datasetArtifact']
url='https://huggingface.co/datasets/'+a['dataset']+'/resolve/'+a['revision']+'/data/test-00000-of-00001.parquet'
with urllib.request.urlopen(url,timeout=60) as response: data=response.read(128*1024*1024+1)
if len(data)>128*1024*1024 or hashlib.sha256(data).hexdigest()!=a['sha256']: raise ValueError('Dataset download differs')
with open('/opt/factory/dataset.parquet','xb') as output: output.write(data)
PY
touch /run/factory-evaluator
/opt/factory/swe-python/bin/python -I /opt/factory/workload/evaluate.py /opt/factory/workload/manifest.json /opt/factory/dataset.parquet /opt/factory/swe-upstream /opt/factory/evaluation
`;
const files = { 'evaluate.py': readFileSync(fileURLToPath(new URL('../evaluators/swe-bench/run.py', import.meta.url))).toString('base64'),
  'manifest.json': Buffer.from(JSON.stringify(manifest)).toString('base64'),
  'prepare.sh': Buffer.from(shell).toString('base64'),
  'verify.sh': Buffer.from('#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root /bin/sh /opt/factory/workload/prepare.sh\n').toString('base64') };
const job = createGitHubJob({ repository, transport, workflowId: Number(workflowId), ref, commit, timeoutMs: 1_800_000, pollMs: 10000,
  async stage(c, resource) {
    await createGuestStager({ files, sha256: hash(canonicalJson(files)) }, commit)(c, resource);
    await installVerificationEntry(resource.manifestPath);
  },
  async retain(c, resource, run) {
    const saved = c.record('benchmarkEvidence'); if (saved) return saved;
    const destination = join(root, 'retained'); mkdirSync(destination, { mode: 0o700 });
    const paths = ['receipt.json', 'preparation.log', 'test-output.txt', 'dependencies.txt', 'native-instance.log', 'native-report.json'];
    const retained = await captureTartFiles(resource.manifestPath, { root: '/opt/factory/benchmark-proof', paths, destination,
      ...(run.conclusion === 'success' ? {} : { optionalPaths: paths }) });
    const receiptFile = retained.find(file => file.path === 'receipt.json');
    const receipt = receiptFile ? JSON.parse(readFileSync(receiptFile.localPath, 'utf8')) : null;
    const evidence = { retained, receipt }; c.checkpoint('benchmarkEvidence', evidence); return evidence;
  },
  async verify(_c, retained) {
    const { receipt, retained: captured } = retained as { retained: { path: string; localPath: string; sha256: string }[];
      receipt: Parameters<typeof importSweBenchResult>[1] & { containerRemoved: boolean; image: string; datasetSha256: string; testOutputSha256: string } };
    assert.equal(receipt.containerRemoved, true);
    assert.equal(receipt.image, manifest.image);
    assert.equal(receipt.datasetSha256, manifest.datasetArtifact.sha256);
    for (const file of captured) assert.equal(hash(readFileSync(file.localPath)), file.sha256);
    assert.equal(captured.find(file => file.path === 'test-output.txt')?.sha256, receipt.testOutputSha256);
    const result = importSweBenchResult(evaluation, receipt);
    assert.equal(result.outcome, expected);
    const native = result.nativeReport[evaluation.input.instanceId];
    if (expected !== 'infrastructure_failure') assert.equal(native.patch_successfully_applied, true);
    if (expected === 'unresolved') {
      assert.ok(native.tests_status.FAIL_TO_PASS.failure.length > 0, 'The baseline control must reproduce a failing target test');
      assert.equal(native.tests_status.PASS_TO_PASS.failure.length, 0, 'Existing passing tests must remain passing');
    }
    return { accepted: true, evidence: result }; // Evaluation completed; resolved/unresolved remains native data.
  },
});
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const executor = createTartExecutor({ root, binaries: { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') }, repository, transport, job,
  checks: { subject: 'native-evaluator-proof', authorize: async () => ({ status: 'verified', evidenceId: 'explicit-credential-free-evaluator' }), inspectSecret: async () => { throw Error('No secrets allowed'); } } });
try {
  const result = await executor.execute(context);
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ result, runId: context.record('workflowRunId'), modelCalls: 0, evaluation }, null, 2));
  store.finish(attemptId, result.outcome, result.result);
  assert.equal(result.outcome, 'succeeded');
} finally {
  await executor.recover(context);
  const path = context.record('manifestPath'); if (typeof path === 'string') assert.equal((await inspectTartDeployment(path)).present, false);
  const intent = context.record('runnerIntent') as RunnerIntent | null; if (intent) assert.equal(await findGitHubRunner(transport, intent), null);
  writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ independentlyAbsent: true, workflowRunId: context.record('workflowRunId') }));
  store.close();
}
