import { factoryTartOptions } from '../src/defaults.js';
/** Actual Actions + JIT + fresh VM verification; synthetic candidate, no model call or job secrets. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGitHubTransport, inspectTartDeployment, findGitHubRunner, type RunnerIntent } from '@intelligent-iterations/ii-agent-runtime';
import { createCodeAcceptance } from '../src/code-acceptance.js';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt } from '../src/guest-retain.js';

const [repository, image, workflowId, ref, commit, directory, mode] = process.argv.slice(2);
if (!repository || !image || !workflowId || !ref || !commit || !directory || (mode !== undefined && !['--cancel-after-dispatch', '--parallel-proof'].includes(mode))) throw Error('Usage: verify-actions.ts repository image workflow-id ref exact-commit new-directory [--cancel-after-dispatch|--parallel-proof]');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const source = join(root, 'source'); const outputs = join(root, 'outputs'); mkdirSync(source); mkdirSync(outputs);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Verification', GIT_AUTHOR_EMAIL: 'verification@localhost', GIT_COMMITTER_NAME: 'Verification', GIT_COMMITTER_EMAIL: 'verification@localhost' };
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init');
writeFileSync(join(source, 'answer.txt'), 'wrong'); git('add', '.'); git('commit', '-m', 'base');
const baseCommit = git('rev-parse', 'HEAD'); const baseBundle = join(root, 'base.bundle'); git('bundle', 'create', baseBundle, 'HEAD');
const proofFile = 'answer.txt';
writeFileSync(join(source, proofFile), 'correct');
const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit, secretValues: [] });
const store = new WorkStore(join(root, 'work.sqlite'));
const task = store.submit('live-actions-proof', 'candidate', { role: { kind: 'code' }, repository, baseCommit });
const attemptId = store.claim(task.id)!;
const context: ExecutionContext = { attemptId, task: store.get(task.id), cancelled: () => store.get(task.id).cancelRequested,
  record: key => store.record(attemptId, key), checkpoint: (key, value) => {
    store.checkpoint(attemptId, key, value);
    if (['verification:manifestPath', 'verification:runnerReceipt', 'verification:workflowRunId', 'verification:vmRemoved'].includes(key)) console.log(key, JSON.stringify(value));
  } };
const provider = createGitHubTransport((url, init) => fetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }));
const transport: typeof provider = { async request(method, path, body) {
  const result = await provider.request(method, path, body);
  if (mode === '--cancel-after-dispatch' && method === 'POST' && path.endsWith('/dispatches') && [200, 204].includes(result.status)) store.requestCancel(task.id);
  return result;
} };
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const acceptance = createCodeAcceptance({ root, outputRoot: outputs, repository, transport, jobTimeoutMs: 300_000,
  workflow: { id: Number(workflowId), ref, commit }, binaries: { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') },
  checks: { subject: 'live-verification', authorize: async () => ({ status: 'verified', evidenceId: 'explicit-self-hosted-verification' }), inspectSecret: async () => { throw Error('No job secrets assigned'); } },
  setup: { schemaVersion: 1, id: 'verification', revision: '1', harness: { name: 'verification', version: '1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['verification.json'] } },
  baseBundle: async () => ({ path: baseBundle, sha256: hash(readFileSync(baseBundle)) }),
  policy: async () => [{ id: 'answer', interpreter: '/usr/local/bin/node', timeoutMs: mode === '--cancel-after-dispatch' || mode === '--parallel-proof' ? 60000 : 1000,
    script: mode === '--cancel-after-dispatch' || mode === '--parallel-proof' ? "setTimeout(()=>process.stdout.write(require('node:fs').readFileSync('answer.txt')),30000)" : `if(process.getuid()===0)process.exit(9);process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(proofFile)}))`, stdoutSha256: hash('correct') }],
});
const retained = { worker: { candidate, executionId: context.task.id, attemptId: context.attemptId }, files: [{ path: candidate.bundle, localPath: join(source, candidate.bundle), size: candidate.size, sha256: candidate.sha256 }] } as RetainedAttempt;
try {
  const result = await acceptance.verify(context, retained);
  assert.equal(result.accepted, mode !== '--cancel-after-dispatch');
  assert.ok(context.record('verification:workflowRunId'));
  if (mode === '--cancel-after-dispatch') assert.equal((context.record('verification:workflowTerminal') as { conclusion: string }).conclusion, 'cancelled');
  assert.equal(context.record('verification:vmRemoved'), true); assert.equal(context.record('verification:runnerRemoved'), true);
  store.finish(attemptId, result.accepted ? 'succeeded' : 'cancelled', result);
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ result, workflowRunId: context.record('verification:workflowRunId'), candidate, sourceRevision: gitSourceRevision() }, null, 2));
  console.log('Actual Actions verification completed with retained evidence');
} finally {
  await acceptance.recoverVerification(context);
  const manifestPath = context.record('verification:manifestPath');
  if (typeof manifestPath === 'string') assert.equal((await inspectTartDeployment(manifestPath)).present, false);
  const intent = context.record('verification:runnerIntent') as RunnerIntent | null;
  if (intent) assert.equal(await findGitHubRunner(provider, intent), null);
  writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ independentlyAbsent: true, workflowRunId: context.record('verification:workflowRunId') }));
  store.close(); console.log('VM and JIT runner independently absent');
}
function gitSourceRevision() { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
