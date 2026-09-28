import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { validateCandidateLinks } from './candidate-links.js';

export interface CodeCandidate { baseCommit: string; commit: string; tree: string; bundle: string; sha256: string; size: number }
export const candidateBundle = 'candidate.bundle';
/** Guest-only: materialize a candidate in a fresh Git repository, without adopting agent Git configuration. */
export async function sealCodeCandidate(options: { workspace: string; directory: string; baseCommit: string; secretValues: readonly string[]; maxBytes?: number }): Promise<CodeCandidate> {
  if (!/^[a-f0-9]{40}$/.test(options.baseCommit)) throw Error('Invalid candidate base');
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid candidate limit');
  const workspace = realpathSync(options.workspace);
  const directory = resolve(options.directory);
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw Error('Candidate directory must be canonical');
  const home = join(directory, 'home'); const snapshot = join(directory, 'snapshot');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(snapshot, { mode: 0o700 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Factory', GIT_AUTHOR_EMAIL: 'factory@localhost',
    GIT_COMMITTER_NAME: 'Factory', GIT_COMMITTER_EMAIL: 'factory@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const git = async (cwd: string, args: string[]) => (await promisify(execFile)('/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env, timeout: 120_000, maxBuffer: maxBytes })).stdout;
  // Only tracked and nonignored new paths belong to the proposed change. Removed files stay removed.
  const paths = new Set((await git(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  if (paths.has(candidateBundle)) throw Error('Candidate bundle path is reserved');
  let size = 0;
  const entries = new Map<string, string | null>();
  const links: { path: string; target: string }[] = [];
  for (const path of paths) {
    if (path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || path.startsWith('/') || path.includes('\\')) throw Error('Invalid candidate path');
    const source = join(workspace, path);
    let stat;
    try { stat = lstatSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const linked = stat.isSymbolicLink();
    if ((!stat.isFile() && !linked) || stat.nlink !== 1 || realpathSync(dirname(source)) !== dirname(source) ||
        (!linked && realpathSync(source) !== source) || stat.size > maxBytes - size) throw Error('Unsupported or oversized candidate file');
    const bytes = linked ? readlinkSync(source, { encoding: 'buffer' }) : readFileSync(source);
    if (bytes.length !== stat.size || options.secretValues.some(secret => secret && bytes.includes(Buffer.from(secret)))) throw Error('Unsafe candidate bytes');
    size += bytes.length;
if (linked) {
      const target = bytes.toString('utf8');
      if (!Buffer.from(target).equals(bytes)) throw Error('Invalid candidate link encoding');
      entries.set(path, target); links.push({ path, target }); continue;
    }
    entries.set(path, null);
    const destination = join(snapshot, path); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { flag: 'wx', mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  }
  validateCandidateLinks(entries);
  for (const link of links) { const destination = join(snapshot, link.path); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); symlinkSync(link.target, destination); }
  await git(snapshot, ['init']);
  await git(snapshot, ['-c', 'protocol.file.allow=always', 'fetch', '--depth=1', '--no-tags', workspace, options.baseCommit]);
  if ((await git(snapshot, ['rev-parse', 'FETCH_HEAD'])).trim() !== options.baseCommit) throw Error('Candidate base mismatch');
  await git(snapshot, ['add', '--force', '--all']);
  const tree = (await git(snapshot, ['write-tree'])).trim();
  const commit = (await git(snapshot, ['commit-tree', tree, '-p', options.baseCommit, '-m', 'Factory candidate'])).trim();
  await git(snapshot, ['update-ref', 'refs/heads/factory-candidate', commit]);
  const bundle = join(directory, candidateBundle);
  await git(snapshot, ['bundle', 'create', bundle, `${options.baseCommit}..refs/heads/factory-candidate`]);
  const bytes = readFileSync(bundle);
  if (bytes.length > maxBytes) throw Error('Candidate bundle exceeds limit');
  writeFileSync(join(workspace, candidateBundle), bytes, { flag: 'wx', mode: 0o600 });
  return { baseCommit: options.baseCommit, commit, tree, bundle: candidateBundle, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
