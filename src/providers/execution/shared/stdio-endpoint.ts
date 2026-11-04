import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { requireDirectory } from '../../../runtime/artifact-files.js';
import { UnsupportedPipelineTarget, type Worker, type WorkerSession, type WorkerSessionCommand } from '../../../pipeline/ports.js';

// Runs in the trusted caller's process environment; only protocol bytes cross
// the socket. It neither reads credentials nor forwards environment variables.
const CLIENT = `
const net = require('node:net');
const socket = net.createConnection({path:process.argv[1],allowHalfOpen:true});
socket.on('error', () => { process.exitCode=1; process.stdin.destroy(); });
socket.on('close', () => process.stdin.destroy());
socket.on('end', () => { process.stdin.destroy(); socket.end(); });
process.stdin.on('error', () => { process.exitCode=1; socket.destroy(); });
process.stdout.on('error', () => socket.destroy());
process.stdin.pipe(socket); socket.pipe(process.stdout);
`;

export interface WorkerStdioEndpoint {
  /** Executable and argv for a trusted harness's stdio executor configuration. */
  command: string;
  args: string[];
  completion: Promise<{ exitCode: number }>;
  close(): Promise<void>;
}

/** One private, single-use local connection to a bounded worker command. */
export async function openWorkerStdioEndpoint(worker: Pick<Worker, 'open'>, command: WorkerSessionCommand,
  options: { parent: string }): Promise<WorkerStdioEndpoint> {
  if (!worker.open) throw new UnsupportedPipelineTarget('worker.open', 'duplex-command-unavailable');
  if (command.signal?.aborted) throw Error('Worker endpoint canceled');
  if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 7200000) throw Error('Invalid endpoint deadline');
  const owner = randomBytes(16).toString('hex');
  const directory = join(requireDirectory(options.parent), `stdio-${owner}`);
  const path = join(directory, 'socket');
  // Darwin's Unix socket pathname limit is smaller than Linux's.
  if (Buffer.byteLength(path) > 100) throw Error('Worker endpoint path exceeds Unix socket limit');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
  const abort = new AbortController();
  const signal = command.signal ? AbortSignal.any([command.signal, abort.signal]) : abort.signal;
  let session: WorkerSession | undefined;
  let connection: Socket | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let accepted = false;
  let resolveCompletion!: (value: { exitCode: number }) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<{ exitCode: number }>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => {});
  const deadline = Date.now() + command.timeoutMs;
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (accepted || signal.aborted) { socket.destroy(); return; }
    accepted = true; connection = socket;
    socket.on('error', () => {});
    active = (async () => {
      try {
        session = await worker.open!({ ...command, timeoutMs: Math.max(1, deadline - Date.now()), signal });
        const input = (async () => { for await (const chunk of socket.iterator({ destroyOnReturn: false })) await session!.write(chunk); session!.end(); })();
        const output = (async () => {
          for await (const chunk of session!.output) await new Promise<void>((resolve, reject) =>
            socket.write(chunk, error => error ? reject(Error('Worker endpoint output interrupted')) : resolve()));
          socket.end();
        })();
        // A failed transport closes the peer, unblocking the other direction.
        void input.catch(() => { socket.destroy(); abort.abort(); });
        void output.catch(() => { socket.destroy(); abort.abort(); });
        const result = await session.completion;
        await Promise.all([input, output]);
        resolveCompletion(result);
      } catch {
        rejectCompletion(Error('Worker command transport failed'));
      } finally {
        socket.destroy();
        await session?.close();
      }
    })();
    void active.catch(() => rejectCompletion(Error('Worker command transport cleanup failed')));
  });
  const canceled = () => {
    connection?.destroy();
    rejectCompletion(Error('Worker endpoint canceled or expired'));
  };
  signal.addEventListener('abort', canceled, { once: true });
  const timer = setTimeout(() => abort.abort(), command.timeoutMs);
  const cleanupFiles = () => {
    if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== owner ||
      readdirSync(directory).some(name => name !== '.owner')) throw Error('Worker endpoint cleanup unconfirmed');
    unlinkSync(join(directory, '.owner')); rmdirSync(directory);
  };
  const close = () => closing ??= (async () => {
    clearTimeout(timer); abort.abort();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(Error('Worker endpoint listener cleanup failed')) : resolve()));
    connection?.destroy();
    await active;
    await stopped;
    signal.removeEventListener('abort', canceled);
    cleanupFiles();
  })();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    server.removeAllListeners('error');
    server.on('error', () => { abort.abort(); });
    chmodSync(path, 0o600);
  } catch {
    clearTimeout(timer); abort.abort(); signal.removeEventListener('abort', canceled);
    // An unsuccessful bind owns no socket; unknown filesystem entries are retained.
    cleanupFiles();
    throw Error('Worker endpoint could not listen');
  }
  return { command: process.execPath, args: ['-e', CLIENT, path], completion, close };
}
