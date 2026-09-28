import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import { validateCandidateLinks } from './candidate-links.js';
import type { CodeCandidate } from './code-candidate.js';

export interface AcceptanceCheck {
  id: string;
  /** Operator-owned script, separate from candidate files. */
  script: string;
  interpreter: string;
  timeoutMs: number;
  /** Optional exact stdout contract, checked outside the candidate process. */
  stdoutSha256?: string;
}
export interface CodeVerificationInput {
  executionId: string; attemptId: string; candidate: CodeCandidate;
  baseBundle: { path: string; sha256: string }; candidateBundlePath: string;
  directory: string; checks: AcceptanceCheck[];
  /** Dedicated unprivileged identity in the verification guest. */
  identity: { uid: number; gid: number };
}
export interface CodeVerificationResult {
  schemaVersion: 1; executionId: string; attemptId: string; commit: string; baseCommit: string; tree: string;
  bundleSha256: string; policySha256: string; accepted: boolean;
  checks: { id: string; passed: boolean; exitCode: number | null; reason: string; stdoutSha256: string }[];
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function checkedFile(path: string, expected: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== resolve(path) || stat.size > 64 * 1024 * 1024) throw Error('Invalid verification input file');
  const bytes = readFileSync(path);
  if (hash(bytes) !== expected) throw Error('Verification input digest mismatch');
  return bytes;
}
export function validateAcceptanceChecks(checks: AcceptanceCheck[]): void {
  if (!checks.length || checks.length > 32 || new Set(checks.map(check => check.id)).size !== checks.length || checks.some(check =>
    !/^[a-zA-Z0-9_-]+$/.test(check.id) || !isAbsolute(check.interpreter) || !check.script.length || check.script.length > 1024 * 1024 ||
    !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 300_000 ||
    (check.stdoutSha256 !== undefined && !/^[a-f0-9]{64}$/.test(check.stdoutSha256)))) throw Error('Invalid acceptance policy');
}

/** Guest-only. The controller must allocate a fresh verification VM and retain this result before removal. */
export async function runCodeVerification(options: CodeVerificationInput): Promise<CodeVerificationResult> {
  const input = structuredClone(options);
  const candidate = input.candidate;
  if (![candidate.commit, candidate.baseCommit, candidate.tree].every(value => /^[a-f0-9]{40}$/.test(value)) ||
      !/^[a-f0-9]{64}$/.test(candidate.sha256) || !input.executionId || !input.attemptId ||
      !Number.isSafeInteger(input.identity.uid) || input.identity.uid <= 0 || !Number.isSafeInteger(input.identity.gid) || input.identity.gid <= 0) throw Error('Invalid verification identity');
  validateAcceptanceChecks(input.checks);
  const baseBytes = checkedFile(input.baseBundle.path, input.baseBundle.sha256);
  const candidateBytes = checkedFile(input.candidateBundlePath, candidate.sha256);
  if (candidateBytes.length !== candidate.size) throw Error('Candidate size mismatch');
  const directory = resolve(input.directory); mkdirSync(directory, { mode: 0o755 });
  if (realpathSync(directory) !== directory) throw Error('Verification directory must be canonical');
  const workspace = join(directory, 'workspace'); const home = join(directory, 'home');
  mkdirSync(workspace, { mode: 0o755 }); mkdirSync(home, { mode: 0o700 });
  chownSync(home, input.identity.uid, input.identity.gid);
  writeFileSync(join(directory, 'base.bundle'), baseBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'candidate.bundle'), candidateBytes, { flag: 'wx', mode: 0o600 });
  const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const gitRaw = async (...args: string[]) => (await promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd: workspace, env: gitEnv, timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout;
  const git = async (...args: string[]) => (await gitRaw(...args)).trim();
  await git('init');
  await git('fetch', join(directory, 'base.bundle'), candidate.baseCommit);
  if (await git('rev-parse', 'FETCH_HEAD') !== candidate.baseCommit) throw Error('Base commit mismatch');
  await git('bundle', 'verify', join(directory, 'candidate.bundle'));
  if (await git('bundle', 'list-heads', join(directory, 'candidate.bundle')) !== `${candidate.commit} refs/heads/factory-candidate`) throw Error('Unexpected candidate references');
  await git('fetch', join(directory, 'candidate.bundle'), 'refs/heads/factory-candidate');
  if (await git('rev-parse', 'FETCH_HEAD') !== candidate.commit || await git('show', '-s', '--format=%P', candidate.commit) !== candidate.baseCommit ||
      await git('rev-parse', candidate.commit + '^{tree}') !== candidate.tree) throw Error('Candidate identity mismatch');
  let treeBytes = 0;
  const entries = new Map<string, string | null>();
  for (const entry of (await git('ls-tree', '-r', '-l', '-z', candidate.commit)).split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob [a-f0-9]{40} +([0-9]+)\t(.+)$/s.exec(entry);
    if (!match || match[3]!.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || match[3]!.includes('\\')) throw Error('Unsupported candidate tree');
if (match[1] === '120000') {
      if (Number(match[2]) > 4096) throw Error('Unsupported candidate tree');
      const target = await gitRaw('cat-file', 'blob', `${candidate.commit}:${match[3]}`);
      if (Buffer.byteLength(target) !== Number(match[2])) throw Error('Invalid candidate link encoding');
      entries.set(match[3]!, target);
    } else entries.set(match[3]!, null);
    treeBytes += Number(match[2]);
    if (!Number.isSafeInteger(treeBytes) || treeBytes > 64 * 1024 * 1024) throw Error('Candidate tree exceeds limit');
  }
  validateCandidateLinks(entries);
  await git('checkout', '--detach', candidate.commit);
  const result: CodeVerificationResult = { schemaVersion: 1, executionId: input.executionId, attemptId: input.attemptId,
    commit: candidate.commit, baseCommit: candidate.baseCommit, tree: candidate.tree, bundleSha256: candidate.sha256,
    policySha256: hash(canonicalJson(input.checks)), accepted: false, checks: [] };
  for (const check of input.checks) {
    const scriptPath = join(directory, `check-${check.id}`);
    writeFileSync(scriptPath, check.script, { flag: 'wx', mode: 0o444 }); chmodSync(scriptPath, 0o444);
    const observed = await new Promise<CodeVerificationResult['checks'][number]>(resolveCheck => {
      const child = spawn(check.interpreter, [scriptPath], { cwd: workspace, detached: true, uid: input.identity.uid, gid: input.identity.gid,
        env: { PATH: gitEnv.PATH, HOME: home, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let reason = 'exit'; let bytes = 0; const stdout = createHash('sha256');
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      const stop = (value: string) => { reason = value; kill(); };
      const timer = setTimeout(() => stop('timeout'), check.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; stdout.update(chunk); if (bytes > 1024 * 1024) stop('output_limit'); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) stop('output_limit'); });
      child.once('error', () => stop('launch_failed'));
      child.once('close', exitCode => {
        clearTimeout(timer); kill(); const digest = stdout.digest('hex');
        const passed = reason === 'exit' && exitCode === 0 && (check.stdoutSha256 === undefined || digest === check.stdoutSha256);
        resolveCheck({ id: check.id, passed, exitCode, reason: !passed && reason === 'exit' && exitCode === 0 ? 'stdout_mismatch' : reason, stdoutSha256: digest });
      });
    });
    result.checks.push(observed);
  }
  result.accepted = result.checks.every(check => check.passed);
  const fd = openSync(join(directory, 'verification.json'), 'wx', 0o600);
  try { writeFileSync(fd, canonicalJson(result) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return result;
}
