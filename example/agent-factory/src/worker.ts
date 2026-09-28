import { createFactoryTelemetry as createTelemetryCollector } from './telemetry.js';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, parseSetup, githubTokenRequest, inspectGitHubRepositoryToken, type GitHubTokenAudit } from '@intelligent-iterations/ii-agent-runtime';
import type { Role } from './index.js';
import { sealCodeCandidate, candidateBundle, type CodeCandidate } from './code-candidate.js';
import { authCredentialReference } from './role-credentials.js';
import { workloadDigest } from './workload-identity.js';

export interface WorkerInput { executionId: string; attemptId: string; role: Role; task: string; repository?: string; baseCommit?: string; sourceBundle?: { sha256: string; size: number }; secretTransport?: 'indexed' }
export interface WorkerOptions {
  directory: string;
  input: WorkerInput;
  environment: NodeJS.ProcessEnv;
  codexBinary?: string;
  sourceBundlePath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  workloadDigest?: string;
}
export interface WorkerResult {
  schemaVersion: 1; executionId: string; attemptId: string;
  workloadDigest?: string;
  state: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  exitCode: number | null; telemetryComplete: boolean; observedUsage: boolean;
  workspace: string; telemetry: string;
  candidate?: CodeCandidate;
  sealFailure?: { reason: string };
  githubTokenAudit?: GitHubTokenAudit;
  artifacts: { path: string; size: number; sha256: string }[]; outputGaps: string[];
}
function save(path: string, value: unknown) {
  const temporary = path + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, canonicalJson(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
async function loginWithApiKey(binary: string, env: NodeJS.ProcessEnv, key: string, signal?: AbortSignal): Promise<void> {
  const child = spawn(binary, ['login', '--with-api-key'], { env, stdio: ['pipe', 'ignore', 'ignore'], ...(signal ? { signal } : {}) });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdin.on('error', () => {});
  child.stdin.end(key + '\n');
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw Error('Codex API-key login failed');
  } finally { clearTimeout(timer); }
}

/** Runs only inside a fresh execution guest. A completed harness run is not an accepted task result. */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const input = structuredClone(options.input);
  if (options.workloadDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.workloadDigest)) throw Error('Invalid workload digest');
  const setup = parseSetup(input.role.setup);
  if (setup.harness.name !== 'codex' || input.role.kind !== 'code' || input.role.authMode !== 'api-key' || !input.task.trim() || !input.role.instructions.trim()) throw Error('Invalid worker task');
  if (input.role.model !== undefined && !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.role.model)) throw Error('Invalid harness model');
  const timeoutMs = options.timeoutMs ?? 3_000_000;
  const maxBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('Invalid worker limits');
  const directory = resolve(options.directory);
  // Exclusive creation prevents accidentally adopting another attempt's credentials or outputs.
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw Error('Worker directory must be canonical');
  const workspace = join(directory, 'workspace'); const home = join(directory, 'home'); const authHome = join(directory, 'codex');
  for (const path of [workspace, home, authHome]) mkdirSync(path, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: authHome, LANG: 'C.UTF-8' };
  const secrets: string[] = [];
  for (const [index, reference] of setup.secrets.entries()) {
    const value = options.environment[input.secretTransport === 'indexed' ? `FACTORY_SECRET_${index}` : reference.key];
    if (value === undefined || !value.length) throw Error('A declared secret is unavailable');
    if (Object.hasOwn(env, reference.key) || reference.key.startsWith('GITHUB_') || reference.key.startsWith('RUNNER_') ||
        ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE'].includes(reference.key) ||
        ['NODE_OPTIONS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(reference.key)) throw Error('Secret conflicts with worker control environment');
    env[reference.key] = value; secrets.push(value);
  }
  if (setup.secrets.length !== 1 || setup.secrets[0]?.key !== input.role.credentialKey) throw Error('Unexpected worker secret binding');
  const credential = authCredentialReference(input.role);
  const authValue = credential ? env[credential.key] : undefined;
  if (!authValue || !/^[\x21-\x7e]{3,4096}$/.test(authValue)) throw Error('Invalid Codex API key');
  delete env[credential.key];
  const repositoryToken = options.environment.FACTORY_AGENT_GITHUB_TOKEN;
  if (repositoryToken) { env.GH_TOKEN = repositoryToken; secrets.push(repositoryToken); }
  const telemetryPath = join(directory, 'telemetry.sqlite');
  const collector = createTelemetryCollector({ database: telemetryPath, setup, executionId: input.executionId, attemptId: input.attemptId, secretValues: secrets });
  const result: WorkerResult = { schemaVersion: 1, executionId: input.executionId, attemptId: input.attemptId, state: 'failed', exitCode: null,
    ...(options.workloadDigest === undefined ? {} : { workloadDigest: options.workloadDigest }),
    telemetryComplete: true, observedUsage: false, workspace, telemetry: telemetryPath, artifacts: [], outputGaps: [] };
  try {
    writeFileSync(join(authHome, 'config.toml'), 'cli_auth_credentials_store = "file"\nforced_login_method = "api"\n', { flag: 'wx', mode: 0o600 });
    await collector.publish({ source: 'agent', kind: 'hook', eventType: 'worker.started', payload: { role: input.role.kind } });
    if (input.role.kind === 'code' && repositoryToken) {
      result.githubTokenAudit = await inspectGitHubRepositoryToken(input.repository!, githubTokenRequest(repositoryToken));
      await collector.publish({ source: 'agent', kind: 'hook', eventType: 'github.token.audit', payload: result.githubTokenAudit });
      for (const warning of result.githubTokenAudit.warnings) console.error(`GitHub token scope warning: ${warning}`);
    }
    const binary = options.codexBinary ?? '/usr/local/bin/codex';
    const version = await promisify(execFile)(binary, ['--version'], { env, timeout: 10_000, maxBuffer: 4096, ...(options.signal ? { signal: options.signal } : {}) });
    if (version.stdout.trim() !== `codex-cli ${setup.harness.version}`) throw Error('Harness version mismatch');
    await loginWithApiKey(binary, env, authValue, options.signal);
    const cache = join(authHome, 'auth.json'); const stat = lstatSync(cache);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 48 * 1024 || realpathSync(cache) !== cache) throw Error('Unsafe Codex API-key cache');
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved?.auth_mode !== 'apikey' || saved.OPENAI_API_KEY !== authValue) throw Error('Codex API-key login did not select the assigned key');
    if (input.role.kind === 'code') {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(input.repository ?? '') || !/^[a-f0-9]{40}$/.test(input.baseCommit ?? '')) throw Error('Invalid code source');
      const gitEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
      if (repositoryToken) {
        gitEnv.GIT_CONFIG_COUNT = '1'; gitEnv.GIT_CONFIG_KEY_0 = 'http.extraHeader';
        gitEnv.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${repositoryToken}`).toString('base64');
      }
      const git = (args: string[]) => promisify(execFile)('/usr/bin/git', args, { cwd: workspace, env: gitEnv, timeout: 120_000, maxBuffer: 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
      await git(['init']);
      if (input.sourceBundle) {
        const source = options.sourceBundlePath ?? '/opt/factory/workload/source.bundle';
        const stat = lstatSync(source); const expected = input.sourceBundle;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || stat.size !== expected.size || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw Error('Invalid staged source');
        if (createHash('sha256').update(readFileSync(source)).digest('hex') !== expected.sha256) throw Error('Staged source changed');
        await git(['bundle', 'verify', source]);
        await git(['fetch', source, input.baseCommit!]);
      } else {
        await git(['-c', 'http.followRedirects=false', 'fetch', '--depth=1', `https://github.com/${input.repository}.git`, input.baseCommit!]);
      }
      await git(['checkout', '--detach', 'FETCH_HEAD']);
      if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== input.baseCommit) throw Error('Source commit mismatch');
    }
    if (options.signal?.aborted) { result.state = 'cancelled'; return result; }
    const args = ['exec', '--json', ...(input.role.model ? ['--model', input.role.model] : []), '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--cd', workspace, '-'];
    const child = spawn(binary, args, { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    let bytes = 0; let sequence = 0; let buffer = ''; let failed = false;
    const stop = (state: WorkerResult['state']) => {
      failed = true; result.state = state;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Guest removal is the outer cleanup boundary. */ } }
      child.stdout.destroy(); child.stderr.destroy();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const closed = new Promise<number | null>(resolveClose => {
      child.once('error', () => { failed = true; resolveClose(null); });
      child.once('close', code => resolveClose(code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input.role.instructions + '\n\nTask:\n' + input.task);
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) stop('failed'); });
    async function capture(line: string) {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { result.telemetryComplete = false; return; }
      if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'turn.completed') {
        const usage = (event as { usage?: Record<string, unknown> }).usage;
        result.observedUsage = !!usage && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0);
      }
      try {
        event = JSON.parse(JSON.stringify(event, (_key, value: unknown) => {
          if (typeof value !== 'string') return value;
          return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
        }));
        await collector.publish({ source: 'codex', kind: 'transcript', eventType: 'codex.exec.event', dedupKey: `stdout:${sequence++}`, payload: event });
      } catch { result.telemetryComplete = false; }
    }
    try {
      if (options.signal?.aborted) abort();
      for await (const chunk of child.stdout) {
        bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) { stop('failed'); break; }
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) { await capture(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      }
      if (buffer) await capture(buffer);
    } catch { if (!failed) { result.telemetryComplete = false; stop('failed'); } }
    finally { result.exitCode = await closed; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    if (!failed) result.state = result.exitCode === 0 && result.telemetryComplete && result.observedUsage ? 'completed' : 'failed';
  } catch {
    result.state = options.signal?.aborted ? 'cancelled' : 'failed';
  } finally {
    if (input.role.kind === 'code' && result.state === 'completed') {
      try {
        if (!setup.capture.paths.includes(candidateBundle)) throw Error('Code setup must retain candidate.bundle');
        result.candidate = await sealCodeCandidate({ workspace, directory: join(directory, 'candidate'), baseCommit: input.baseCommit!, secretValues: secrets });
      } catch {
        result.state = 'failed';
        result.sealFailure = { reason: 'candidate_seal_failed' };
      }
    }
    let artifactBytes = 0;
    for (const path of setup.capture.paths) {
      try {
        const file = join(workspace, path);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file) !== file || stat.size > 64 * 1024 * 1024 - artifactBytes) throw Error('Invalid output');
        const bytes = readFileSync(file);
        if (bytes.length !== stat.size || secrets.some(secret => bytes.includes(Buffer.from(secret)))) throw Error('Unsafe output');
        result.artifacts.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        artifactBytes += bytes.length;
      } catch { result.outputGaps.push(path); }
    }
    if (result.outputGaps.length && result.state === 'completed') result.state = 'failed';
    rmSync(join(authHome, 'auth.json'), { force: true });
    try { await collector.publish({ source: 'agent', kind: 'hook', eventType: 'worker.finished', payload: result }); }
    catch { result.telemetryComplete = false; result.state = 'failed'; }
    collector.close();
    save(join(directory, 'result.json'), result);
  }
  return result;
}

/** Worker entry point used by the staged Actions job. */
export async function workerMain(inputPath = '/opt/factory/workload/attempt.json', options: Pick<WorkerOptions, 'directory' | 'codexBinary'> = { directory: '/results/attempt' }): Promise<void> {
  const envelope = JSON.parse(readFileSync(inputPath, 'utf8')) as { attemptId: string; input: WorkerInput; workloadDigest: string; bundleDigest: string; workflowCommit: string };
  if (envelope.attemptId !== envelope.input.attemptId) throw Error('Staged attempt identity mismatch');
  if (workloadDigest({ ...envelope.input }, envelope.bundleDigest, envelope.workflowCommit) !== envelope.workloadDigest) throw Error('Staged workload identity mismatch');
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const tokenPath = '/run/factory-agent-github-token';
    let token: string | undefined;
    try { token = readFileSync(tokenPath, 'utf8'); rmSync(tokenPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!!token !== !!Object.keys(envelope.input.role.githubPermissions ?? {}).length) throw Error('Agent GitHub grant does not match policy');
    const result = await runWorker({ ...options, input: envelope.input,
      environment: { ...process.env, ...(token ? { FACTORY_AGENT_GITHUB_TOKEN: token } : {}) },
      signal: cancellation.signal, workloadDigest: envelope.workloadDigest });
    if (result.state !== 'completed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
