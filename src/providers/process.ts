import { spawn } from 'node:child_process';

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  input?: string | Buffer;
  signal?: AbortSignal;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<string>;

/** No shell, inherited credentials, raw child errors, or automatic retries. */
export const runTrustedProcess: ProcessRunner = async request => new Promise((resolve, reject) => {
  if (request.signal?.aborted) { reject(Error('Process canceled')); return; }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3600000 ||
    !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 10485760) {
    reject(Error('Invalid process limits')); return;
  }
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env,
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const output: Buffer[] = [];
  let bytes = 0;
  let failure: string | undefined;
  const stop = (reason: string) => {
    failure ??= reason;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* close/error remains authoritative */ }
  };
  const timer = setTimeout(() => stop('Process deadline exceeded'), request.timeoutMs);
  const abort = () => stop('Process canceled');
  request.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > request.maxOutputBytes) stop('Process output limit exceeded');
    else output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > request.maxOutputBytes) stop('Process output limit exceeded');
  });
  child.on('error', () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); reject(Error('Process could not start')); });
  child.stdin.on('error', () => stop('Process input interrupted'));
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    if (failure || code !== 0 || signal) reject(Error(failure ?? 'Process failed'));
    else resolve(Buffer.concat(output).toString('utf8'));
  });
  child.stdin.end(request.input);
});
