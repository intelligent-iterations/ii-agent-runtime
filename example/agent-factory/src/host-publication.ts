import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExecutionContext } from './local-coordinator.js';
import type { RetainedAttempt } from './guest-retain.js';
import type { createGitHubApp } from './github-app.js';
export interface BranchReceipt { repository: string; ref: string; commit: string; url: string }

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const refFor = (executionId: string, attemptId: string) =>
  'refs/heads/factory/' + createHash('sha256').update(JSON.stringify([executionId, attemptId])).digest('hex');

/** Publish only a host-retained, hash-checked commit. A lost push is reconciled by exact ref observation. */
export function createHostPublisher(options: {
  app: ReturnType<typeof createGitHubApp>;
  baseBundle(context: ExecutionContext): Promise<{ path: string; sha256: string }>;
  testRemote?: string;
}) {
  return async (context: ExecutionContext, value: unknown): Promise<BranchReceipt> => {
    const retained = value as RetainedAttempt;
    const task = JSON.parse(context.task.input) as { repository?: string; baseCommit?: string };
    const candidate = retained?.worker?.candidate;
    const bundle = retained?.files?.find(file => file.path === 'candidate.bundle');
    if (!task.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repository) ||
        !candidate || !bundle || candidate.baseCommit !== task.baseCommit || bundle.sha256 !== candidate.sha256 ||
        bundle.size !== candidate.size || hash(readFileSync(bundle.localPath)) !== candidate.sha256) throw Error('Retained candidate is invalid');
    const ref = refFor(context.task.id, context.attemptId);
    const previous = context.record('publishedBranch') as BranchReceipt | null;
    const intent = { repository: task.repository, ref, commit: candidate.commit, bundleSha256: candidate.sha256 };
    const saved = context.record('publishIntent');
    if (saved && JSON.stringify(saved) !== JSON.stringify(intent)) throw Error('Publication intent changed');
    if (!saved) context.checkpoint('publishIntent', intent);
    const base = await options.baseBundle(context);
    const baseBytes = readFileSync(base.path);
    if (hash(baseBytes) !== base.sha256 || !lstatSync(base.path).isFile() || realpathSync(base.path) !== base.path) throw Error('Trusted base bundle changed');
    const root = mkdtempSync(join(resolve(bundle.localPath, '..'), 'publish-'));
    const remote = options.testRemote ?? `https://github.com/${task.repository}.git`;
    try {
      const run = async (args: string[], token?: string) => {
        const auth = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : undefined;
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0', ...(auth ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` } : {}) };
        try { return (await promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', ...args],
          { cwd: root, env, timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
        catch { throw Error('Host Git publication command failed'); }
      };
      await run(['init', '--bare']);
      await run(['fetch', '--no-tags', base.path, candidate.baseCommit]);
      await run(['bundle', 'verify', bundle.localPath]);
      await run(['fetch', '--no-tags', bundle.localPath, 'refs/heads/factory-candidate']);
      if (await run(['rev-parse', 'FETCH_HEAD']) !== candidate.commit ||
          await run(['show', '-s', '--format=%P', candidate.commit]) !== candidate.baseCommit ||
          await run(['rev-parse', `${candidate.commit}^{tree}`]) !== candidate.tree) throw Error('Candidate commit changed');
      const result = await options.app.withToken({ repository: task.repository, permissions: { contents: 'write' },
        purpose: 'candidate-publication', recipient: 'host:publisher', attemptId: context.attemptId }, async token => {
        const observe = async () => {
          const found = await run(['ls-remote', '--refs', remote, ref], token);
          if (found && found !== `${candidate.commit}\t${ref}`) throw Error('Candidate branch conflicts with another commit');
          return !!found;
        };
        if (!await observe()) {
          try { await run(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no',
            `--force-with-lease=${ref}:`, remote, `${candidate.commit}:${ref}`], token); }
          catch { if (!await observe()) throw Error('Candidate push is unconfirmed'); }
          if (!await observe()) throw Error('Candidate push is unconfirmed');
        }
        return { repository: task.repository!, ref, commit: candidate.commit,
          url: `https://github.com/${task.repository}/tree/${ref.slice('refs/heads/'.length)}` };
      });
      if (previous && JSON.stringify(previous) !== JSON.stringify(result)) throw Error('Published branch receipt changed');
      context.checkpoint('publishedBranch', result);
      return result;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
