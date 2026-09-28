import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareSweBenchEvaluation, setupDigest } from '@intelligent-iterations/ii-agent-runtime';
import type { AgentRequest } from './index.js';
import type { ExecutionContext } from './local-coordinator.js';
import type { RetainedAttempt } from './guest-retain.js';

export interface SweBenchInstance { instance_id: string; repo: string; base_commit: string; problem_statement: string }
/** Only the task's public inputs enter the agent prompt; gold patches and test labels are not copied. */
export function sweBenchAgentRequest(instance: SweBenchInstance, role: string): AgentRequest {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(instance.instance_id) || !/^[\w.-]+\/[\w.-]+$/.test(instance.repo) ||
      !/^[a-f0-9]{40}$/.test(instance.base_commit) || !instance.problem_statement.trim() || Buffer.byteLength(instance.problem_statement) > 256 * 1024) throw Error('Invalid SWE-bench instance');
  return { role, repository: instance.repo, baseCommit: instance.base_commit, task: instance.problem_statement };
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function checked(path: string, sha256: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || realpathSync(path) !== path) throw Error('Invalid benchmark artifact');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size || hash(bytes) !== sha256) throw Error('Benchmark artifact changed');
  return bytes;
}
/** Export retained code without checking out or executing agent-controlled files on the operator host. */
export async function prepareSweBenchCandidate(options: {
  context: ExecutionContext; retained: RetainedAttempt; instance: SweBenchInstance;
  dataset: string; split: string; datasetRevision: string; evaluatorRevision: string; model: string;
  baseBundle: { path: string; sha256: string }; directory: string;
}) {
  const { context, retained, instance } = options;
  sweBenchAgentRequest(instance, 'validation');
  const task = JSON.parse(context.task.input);
  const candidate = retained.worker.candidate;
  if (task.role.kind !== 'code' || task.repository !== instance.repo || task.baseCommit !== instance.base_commit || task.task !== instance.problem_statement ||
      retained.worker.executionId !== context.task.id || retained.worker.attemptId !== context.attemptId || !candidate || candidate.baseCommit !== instance.base_commit ||
      ![candidate.commit, candidate.baseCommit, candidate.tree].every(value => /^[a-f0-9]{40}$/.test(value))) throw Error('Benchmark candidate correlation mismatch');
  const file = retained.files.find(file => file.path === candidate.bundle);
  if (!file || file.sha256 !== candidate.sha256 || file.size !== candidate.size) throw Error('Missing benchmark candidate');
  const candidateBytes = checked(file.localPath, candidate.sha256);
  if (candidateBytes.length !== candidate.size) throw Error('Benchmark candidate size mismatch');
  const baseBytes = checked(options.baseBundle.path, options.baseBundle.sha256);
  const directory = resolve(options.directory); mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw Error('Benchmark directory must be canonical');
  writeFileSync(join(directory, 'base.bundle'), baseBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'candidate.bundle'), candidateBytes, { flag: 'wx', mode: 0o600 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = async (...args: string[]) => (await promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd: directory, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  await git('init', '--bare');
  await git('fetch', join(directory, 'base.bundle'), candidate.baseCommit);
  if ((await git('rev-parse', 'FETCH_HEAD')).trim() !== candidate.baseCommit) throw Error('Benchmark base mismatch');
  await git('bundle', 'verify', join(directory, 'candidate.bundle'));
  if ((await git('bundle', 'list-heads', join(directory, 'candidate.bundle'))).trim() !== `${candidate.commit} refs/heads/factory-candidate`) throw Error('Unexpected benchmark candidate references');
  await git('fetch', join(directory, 'candidate.bundle'), 'refs/heads/factory-candidate');
  if ((await git('rev-parse', 'FETCH_HEAD')).trim() !== candidate.commit || (await git('show', '-s', '--format=%P', candidate.commit)).trim() !== candidate.baseCommit ||
      (await git('rev-parse', candidate.commit + '^{tree}')).trim() !== candidate.tree) throw Error('Benchmark candidate identity mismatch');
  const patch = await git('diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', candidate.baseCommit, candidate.commit, '--');
  const evaluation = prepareSweBenchEvaluation({ executionId: context.task.id, attemptId: context.attemptId, setupDigest: setupDigest(task.role.setup),
    dataset: options.dataset, split: options.split, datasetRevision: options.datasetRevision, evaluatorRevision: options.evaluatorRevision,
    instanceId: instance.instance_id, model: options.model, patch });
  const predictionsPath = join(directory, 'predictions.jsonl');
  writeFileSync(predictionsPath, evaluation.predictionsJsonl, { flag: 'wx', mode: 0o600 });
  return { evaluation, predictionsPath };
}
