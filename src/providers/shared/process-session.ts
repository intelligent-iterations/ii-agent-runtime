import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import type { WorkerSession } from '../../pipeline/ports.js';
import { ProcessFailure, type ProcessRequest } from './process.js';

export interface ProcessSessionRequest extends Omit<ProcessRequest, 'input'> { maxInputBytes: number }

/** Bounded duplex command transport. Closing it does not prove sandbox removal. */
export async function openTrustedProcess(request: ProcessSessionRequest): Promise<WorkerSession> {
  if (request.signal?.aborted) throw new ProcessFailure('canceled', 'Process canceled');
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 7200000 ||
    [request.maxInputBytes, request.maxOutputBytes].some(value => !Number.isSafeInteger(value) || value < 1 || value > 268435456)) {
    throw Error('Invalid process session limits');
  }
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env,
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let inputBytes = 0, outputBytes = 0;
  let failure: ProcessFailure | undefined;
  let ended = false;
  const stop = (reason: ProcessFailure) => {
    failure ??= reason;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* The process close event remains authoritative. */ }
  };
  const countOutput = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > request.maxOutputBytes) {
      stop(new ProcessFailure('output-limit', 'Process output limit exceeded'));
      return false;
    }
    return true;
  };
  const output = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    if (countOutput(chunk)) callback(null, chunk);
    else callback(failure);
  } });
  // A consumer may attach after spawn. Error listeners avoid an unhandled stream
  // error; iteration and completion still expose the stable failure.
  output.on('error', () => {});
  child.stdout.pipe(output);
  child.stderr.on('data', countOutput);
  child.stdout.on('error', () => stop(new ProcessFailure('exit', 'Process output interrupted')));
  child.stdin.on('error', () => stop(new ProcessFailure('input', 'Process input interrupted')));
  const timer = setTimeout(() => stop(new ProcessFailure('deadline', 'Process deadline exceeded')), request.timeoutMs);
  const abort = () => stop(new ProcessFailure('canceled', 'Process canceled'));
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  const completion = new Promise<{ exitCode: number }>((resolve, reject) => {
    child.on('error', () => stop(new ProcessFailure('spawn', 'Process could not start')));
    child.once('close', (code, signal) => {
      ended = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      if (failure || signal || code === null) {
        const error = failure ?? new ProcessFailure('exit', 'Process interrupted');
        output.destroy(error); reject(error);
      } else resolve({ exitCode: code });
    });
  });
  // Completion is also awaited by close; attaching here prevents a rejection
  // racing a consumer that is still processing stdout.
  void completion.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new ProcessFailure('spawn', 'Process could not start')));
  });
  return {
    output,
    completion,
    async write(input) {
      if (ended || child.stdin.writableEnded || failure) throw failure ?? new ProcessFailure('input', 'Process input closed');
      const bytes = Buffer.from(input);
      inputBytes += bytes.length;
      if (inputBytes > request.maxInputBytes) {
        const error = new ProcessFailure('input', 'Process input limit exceeded');
        stop(error); throw error;
      }
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes,
        error => error ? reject(new ProcessFailure('input', 'Process input interrupted')) : resolve()));
    },
    end() { child.stdin.end(); },
    async close() {
      if (!ended) stop(new ProcessFailure('canceled', 'Process canceled'));
      await completion.catch(() => {});
      output.destroy();
    },
  };
}
