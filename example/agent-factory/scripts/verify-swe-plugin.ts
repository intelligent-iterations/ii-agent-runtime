import { factoryTartOptions } from '../src/defaults.js';
/** Real plugin execution/recovery with a controlled Git candidate. No model invocation. */
import assert from 'node:assert/strict';
import { loadVerificationConfig } from './verification-config.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGitHubTransport, findGitHubRunner, inspectTartDeployment, type RunnerIntent } from '@intelligent-iterations/ii-agent-runtime';
import { createSweBenchBenchmark, type SweBenchBenchmarkOptions } from '../src/swe-bench-controller.js';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt } from '../src/guest-retain.js';
import type { SweBenchInstance } from '../src/swe-bench.js';

const verificationConfig = loadVerificationConfig();
const [mode, directory, image, publicTaskPath, artifactPath] = process.argv.slice(2);
if (!directory || !['prepare', 'execute', 'crash-after-retention', 'recover', 'replay'].includes(mode ?? '')) throw Error('Usage: verify-swe-plugin.ts prepare root image public-task-json dataset-source-json | execute|crash-after-retention|recover|replay root');
const root = resolve(directory);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
if (mode === 'prepare') {
  if (!image || !publicTaskPath || !artifactPath) throw Error('Preparation inputs required');
  mkdirSync(root, { mode: 0o700 }); const source = join(root, 'source'); mkdirSync(source);
  const supplied = JSON.parse(readFileSync(publicTaskPath, 'utf8')) as SweBenchInstance;
  const instance = { instance_id: supplied.instance_id, repo: supplied.repo, base_commit: supplied.base_commit, problem_statement: supplied.problem_statement };
  assert.equal(instance.instance_id, 'psf__requests-1142'); assert.equal(instance.repo, 'psf/requests'); assert.match(instance.base_commit, /^[a-f0-9]{40}$/);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Benchmark control',
      GIT_AUTHOR_EMAIL: 'control@localhost', GIT_COMMITTER_NAME: 'Benchmark control', GIT_COMMITTER_EMAIL: 'control@localhost' } }).trim();
  git('init'); git('fetch', 'https://github.com/psf/requests.git', instance.base_commit); git('checkout', '--detach', 'FETCH_HEAD');
  const basePath = join(root, 'base.bundle'); git('bundle', 'create', basePath, 'HEAD');
  writeFileSync(join(source, 'FACTORY_BENCHMARK_PROBE'), 'Controlled benchmark candidate; no source behavior changed.\n', { flag: 'wx' });
  const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit: instance.base_commit, secretValues: [] });
  const setup = { schemaVersion: 1, id: 'benchmark', revision: '1', harness: { name: 'swe-bench', version: '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 4096 }, secrets: [],
    capture: { paths: ['receipt.json', 'execution.log', 'test-output.txt', 'native-report.json', 'native-instance.log'] } };
  const store = new WorkStore(join(root, 'work.sqlite'));
  try {
    const task = store.submit('swe-bench-live-plugin', 'baseline-control', { repository: instance.repo, baseCommit: instance.base_commit, task: instance.problem_statement,
      role: { kind: 'code', setup: { ...setup, harness: { name: 'controlled-candidate', version: '1' } } } });
    const attemptId = store.claim(task.id)!;
    const retained = { worker: { executionId: task.id, attemptId, candidate }, files: [{ path: candidate.bundle, localPath: join(source, candidate.bundle), size: candidate.size, sha256: candidate.sha256 }] };
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    writeFileSync(join(root, 'inputs.json'), JSON.stringify({ taskId: task.id, attemptId, setup, retained, instance,
      dataset: { dataset: artifact.dataset, split: artifact.split, revision: artifact.revision, sha256: artifact.sha256, file: 'data/test-00000-of-00001.parquet' },
      baseBundle: { path: basePath, sha256: hash(readFileSync(basePath)) } }, null, 2), { flag: 'wx', mode: 0o600 });
  } finally { store.close(); }
  console.log('Prepared real Git candidate without reading gold patches');
} else {
  const inputs = JSON.parse(readFileSync(join(root, 'inputs.json'), 'utf8'));
  const store = new WorkStore(join(root, 'work.sqlite')); let requests = 0; let dispatches = 0;
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const provider = createGitHubTransport((url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }));
  const transport: typeof provider = { async request(method, path, body) {
    requests++; if (path.endsWith('/dispatches')) dispatches++;
    if (mode === 'replay') throw Error('Settled benchmark must replay without provider calls');
    return provider.request(method, path, body);
  } };
  const context: ExecutionContext = { task: store.get(inputs.taskId), attemptId: inputs.attemptId,
    cancelled: () => store.get(inputs.taskId).cancelRequested, record: key => store.record(inputs.attemptId, key),
    checkpoint: (key, value) => {
      store.checkpoint(inputs.attemptId, key, value);
      if (['benchmark:workflowRunId', 'benchmark:vmRemoved', 'benchmark:runnerRemoved', 'benchmark:finished'].includes(key)) console.log(key, JSON.stringify(value));
      if (mode === 'crash-after-retention' && key === 'benchmark:evidence') {
        writeFileSync(join(root, 'crash-boundary.json'), JSON.stringify({ pid: process.pid, checkpoint: key, workflowRunId: context.record('benchmark:workflowRunId') }), { flag: 'wx', mode: 0o600 });
        process.kill(process.pid, 'SIGKILL');
      }
    } };
  const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
  const options: SweBenchBenchmarkOptions = { root, outputRoot: root, setup: inputs.setup, policyRevision: 'live-baseline-control-v1', model: 'controlled-no-model', timeoutSeconds: 300,
    dataset: inputs.dataset, instance: async () => inputs.instance, baseBundle: async () => inputs.baseBundle,
    image: async () => ({ reference: 'swebench/sweb.eval.x86_64.psf_1776_requests-1142@sha256:fa9c859412109d003a68c2bbe3c65541ca4714526afeb6906fe589c18af0b30d', architecture: 'amd64', allowEmulation: true }),
    repository: verificationConfig.repository, transport,
    binaries: { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') },
    workflow: { id: verificationConfig.verificationWorkflowId, ref: verificationConfig.verificationWorkflowRef, commit: verificationConfig.verificationWorkflowCommit },
    checks: { subject: 'live-benchmark-plugin-proof', authorize: async () => ({ status: 'verified', evidenceId: 'credential-free-controlled-benchmark' }), inspectSecret: async () => { throw Error('No secrets assigned'); } } };
  try {
    const plugin = createSweBenchBenchmark(options);
    const result = mode === 'recover' || mode === 'replay' ? await plugin.recover(context) : await plugin.evaluate(context, inputs.retained as RetainedAttempt);
    assert.equal(result?.status, 'completed');
    if (result?.status !== 'completed') throw Error('Benchmark did not complete');
    assert.equal(result.result.outcome, 'unresolved');
    const native = result.result.nativeReport[inputs.instance.instance_id];
    assert.equal(native.tests_status.FAIL_TO_PASS.failure.length, 1); assert.equal(native.tests_status.PASS_TO_PASS.success.length, 5);
    assert.equal(native.tests_status.PASS_TO_PASS.failure.length, 0);
    assert.equal(context.record('benchmark:vmRemoved'), true); assert.equal(context.record('benchmark:runnerRemoved'), true);
    if (mode !== 'replay') {
      assert.equal((await inspectTartDeployment(context.record('benchmark:manifestPath') as string)).present, false);
      assert.equal(await findGitHubRunner(transport, context.record('benchmark:runnerIntent') as RunnerIntent), null);
    }
    if (mode === 'recover' || mode === 'replay') assert.equal(dispatches, 0);
    if (mode === 'replay') assert.equal(requests, 0);
    if (store.attempt(inputs.attemptId).state === 'running') store.finish(inputs.attemptId, 'succeeded', result);
    writeFileSync(join(root, mode + '-proof.json'), JSON.stringify({ result, requests, dispatches, workflowRunId: context.record('benchmark:workflowRunId'), modelCalls: 0, cleanup: 'independently-confirmed-or-replayed' }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Benchmark plugin proof completed', mode);
  } finally { store.close(); }
}
