import { factoryTartOptions } from '../src/defaults.js';
/** SIGKILL/restart proof against a real verification job; no model call or job secrets. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubTransport, inspectTartDeployment, findGitHubRunner, type RunnerIntent } from '@intelligent-iterations/ii-agent-runtime';
import { createCodeAcceptance } from '../src/code-acceptance.js';
import { sealCodeCandidate, type CodeCandidate } from '../src/code-candidate.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt } from '../src/guest-retain.js';

interface ProofInput { repository: string; image: string; workflowId: number; ref: string; commit: string; taskId: string; attemptId: string; baseCommit: string; candidate: CodeCandidate }
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const [mode, location, repository, image, workflowId, ref, commit] = process.argv.slice(2);
if (!location || !['run', 'child', 'recover'].includes(mode ?? '')) throw Error('Usage: verify-actions-crash.ts run new-directory repository image workflow-id ref exact-commit');
const root = resolve(location); const inputPath = join(root, 'input.json');
const json = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
if (mode === 'run') {
  if (!repository || !image || !/^[1-9][0-9]*$/.test(workflowId ?? '') || !ref || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Invalid provider configuration');
  mkdirSync(root, { mode: 0o700 }); const source = join(root, 'source'); mkdirSync(source); mkdirSync(join(root, 'outputs'));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Verification', GIT_AUTHOR_EMAIL: 'verification@localhost', GIT_COMMITTER_NAME: 'Verification', GIT_COMMITTER_EMAIL: 'verification@localhost' };
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(join(source, 'answer.txt'), 'wrong'); git('add', '.'); git('commit', '-m', 'base');
  const baseCommit = git('rev-parse', 'HEAD'); git('bundle', 'create', join(root, 'base.bundle'), 'HEAD');
  writeFileSync(join(source, 'answer.txt'), 'correct');
  const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit, secretValues: [] });
  const store = new WorkStore(join(root, 'work.sqlite'));
  try {
    const task = store.submit('crash-proof', 'candidate', { role: { kind: 'code' }, baseCommit }); const attemptId = store.claim(task.id)!;
    json('input.json', { repository, image, workflowId: Number(workflowId), ref, commit, taskId: task.id, attemptId, baseCommit, candidate });
  } finally { store.close(); }
  async function child(operation: string) {
    const processHandle = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), operation, root], { stdio: 'inherit' });
    const timer = setTimeout(() => processHandle.kill('SIGTERM'), 360_000);
    try { return await new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
      processHandle.once('error', reject); processHandle.once('exit', (code, signal) => resolveExit({ code, signal }));
    }); } finally { clearTimeout(timer); }
  }
  let killed: Awaited<ReturnType<typeof child>> | undefined;
  try { killed = await child('child'); }
  finally { const recovered = await child('recover'); assert.equal(recovered.code, 0, 'Provider cleanup needs reconciliation'); }
  assert.equal(killed?.signal, 'SIGKILL', 'Controller did not reach the active-job crash boundary');
  json('controller-exit.json', killed);
  console.log('Active Actions controller killed; fresh process reconciled without redispatch');
} else {
  const input: ProofInput = JSON.parse(readFileSync(inputPath, 'utf8'));
  const store = new WorkStore(join(root, 'work.sqlite'));
  const context: ExecutionContext = { attemptId: input.attemptId, task: store.get(input.taskId), cancelled: () => false,
    record: key => store.record(input.attemptId, key), checkpoint: (key, value) => {
      store.checkpoint(input.attemptId, key, value);
      if (['verification:manifestPath', 'verification:workflowRunId', 'verification:vmRemoved'].includes(key)) console.log(key, JSON.stringify(value));
    } };
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const provider = createGitHubTransport((url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }));
  const transport: typeof provider = { async request(method, path, body) {
    if (method === 'POST' && path.endsWith('/dispatches')) {
      assert.equal(mode, 'child', 'Recovery attempted redispatch');
      context.checkpoint('proof:dispatchCalls', Number(context.record('proof:dispatchCalls') ?? 0) + 1);
    }
    const response = await provider.request(method, path, body);
    const run = response.body as { id?: number; status?: string } | null;
    if (mode === 'child' && method === 'GET' && /\/actions\/runs\/[0-9]+$/.test(path) && response.status === 200 && run?.status === 'in_progress' && run.id === context.record('verification:workflowRunId')) {
      json('crash.json', { runId: run.id, status: run.status, controllerPid: process.pid, attemptId: input.attemptId });
      console.log('Killing controller during active workflow', run.id); process.kill(process.pid, 'SIGKILL');
    }
    return response;
  } };
  const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
  const acceptance = createCodeAcceptance({ root, outputRoot: join(root, 'outputs'), repository: input.repository, transport, jobTimeoutMs: 300_000,
    workflow: { id: input.workflowId, ref: input.ref, commit: input.commit }, binaries: { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') },
    checks: { subject: 'crash-verification', authorize: async () => ({ status: 'verified', evidenceId: 'owned-credential-free-verification' }), inspectSecret: async () => { throw Error('No job secrets'); } },
    setup: { schemaVersion: 1, id: 'verification', revision: '1', harness: { name: 'verification', version: '1' }, deployment: { provider: 'tart', options: factoryTartOptions(), image: input.image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['verification.json'] } },
    baseBundle: async () => ({ path: join(root, 'base.bundle'), sha256: hash(readFileSync(join(root, 'base.bundle'))) }),
    policy: async () => [{ id: 'held-check', interpreter: '/usr/local/bin/node', timeoutMs: 120000, script: "setTimeout(()=>process.stdout.write(require('node:fs').readFileSync('answer.txt')),90000)", stdoutSha256: hash('correct') }],
  });
  try {
    if (mode === 'child') {
      const candidate = input.candidate;
      await acceptance.verify(context, { worker: { candidate, executionId: context.task.id, attemptId: context.attemptId }, files: [{ path: candidate.bundle, localPath: join(root, 'source', candidate.bundle), size: candidate.size, sha256: candidate.sha256 }] } as RetainedAttempt);
      throw Error('Active workflow was not observed before completion');
    }
    await acceptance.recoverVerification(context);
    const path = context.record('verification:manifestPath');
    if (typeof path === 'string') assert.equal((await inspectTartDeployment(path)).present, false);
    const intent = context.record('verification:runnerIntent') as RunnerIntent | null;
    if (intent) assert.equal(await findGitHubRunner(provider, intent), null);
    json('cleanup.json', { independentlyAbsent: true, manifestPath: path, runId: context.record('verification:workflowRunId') });
    const crashed = JSON.parse(readFileSync(join(root, 'crash.json'), 'utf8'));
    const terminal = context.record('verification:workflowTerminal') as { runId: number; conclusion: string };
    assert.equal(terminal.runId, crashed.runId); assert.equal(terminal.conclusion, 'cancelled');
    assert.equal(context.record('proof:dispatchCalls'), 1);
    const assigned = await provider.request('GET', `/repos/${input.repository}/actions/runs/${crashed.runId}/jobs?filter=all&per_page=100`);
    assert.equal(assigned.status, 200);
    const jobs = assigned.body as { total_count: number; jobs: Array<{ id: number; runner_id: number; head_sha: string; conclusion: string }> };
    const receipt = context.record('verification:runnerReceipt') as { runnerId: number };
    assert.equal(jobs.total_count, 1); assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0]!.runner_id, receipt.runnerId); assert.equal(jobs.jobs[0]!.head_sha, input.commit); assert.equal(jobs.jobs[0]!.conclusion, 'cancelled');
    json('runner-assignment-proof.json', { runnerId: receipt.runnerId, jobId: jobs.jobs[0]!.id, ownedRunnerConfirmed: true, conclusion: 'cancelled' });
    assert.ok(context.record('verification:workflowRetained'));
    json('proof.json', { crash: crashed, terminal, dispatchCalls: 1, outputRetention: context.record('verification:workflowRetained'), independentlyAbsent: true });
    if (store.attempt(input.attemptId).state === 'running') store.finish(input.attemptId, 'failed', { reason: 'interrupted_attempt_reconciled', runId: crashed.runId });
    else assert.equal(store.get(input.taskId).state, 'failed');
    console.log('Existing workflow cancelled; outputs accounted for; VM and runner independently absent');
  } finally { store.close(); }
}
