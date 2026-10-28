import type { RemoteSession } from './channel.js';
import type { Worker, WorkerResources, WorkerCommand } from '../../../pipeline/ports.js';
import type { ProcessRunner } from '../../shared/process.js';
import { join } from 'node:path';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { isIPv4 } from 'node:net';

/** The same worker operations across authenticated cloud transports. */
export async function connectRemoteWorker(options: {
  remote: RemoteSession; resources: WorkerResources; directory: string; owner: string;
  executablePath: string; execute: ProcessRunner; deadlineMs: number; signal?: AbortSignal;
}): Promise<Worker> {
  const { remote, resources, directory, owner, executablePath, execute, signal } = options;
  const remaining = () => Math.max(1, options.deadlineMs - Date.now());
  const worker = await remote.request<{ workspace: string }>('provision', resources, Math.min(300000, remaining()), signal);
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(worker.workspace)) throw Error('Invalid remote workspace');
  const request = <T>(operation: string, value: unknown, timeoutMs: number, requestSignal?: AbortSignal) =>
    remote.request<T>(operation, value, Math.min(timeoutMs, remaining()),
      signal && requestSignal ? AbortSignal.any([signal, requestSignal]) : requestSignal ?? signal);
  const run = (command: WorkerCommand) => {
    const { input, signal, ...value } = command;
    return request<string>('run', { ...value, ...(input === undefined ? {} : { inputBase64: Buffer.from(input).toString('base64') }) }, command.timeoutMs, signal);
  };
  return {
    workspace: worker.workspace, run,
    async load(source) {
      const archive = join(directory, 'source.tar');
      try {
        await execute({ command: 'tar', args: ['-C', source, '-cf', archive, '.'], cwd: directory,
          env: { PATH: executablePath }, timeoutMs: Math.min(120000, remaining()), maxOutputBytes: 65536, ...(signal ? { signal } : {}) });
        if (statSync(archive).size > 512 * 1048576) throw Error('Remote source archive exceeds 512 MiB');
        await run({ command: 'mkdir', args: ['-p', `${worker.workspace}/repository`, `${worker.workspace}/user`], timeoutMs: 20000, maxOutputBytes: 65536 });
        const archivePath = `${worker.workspace}/user/source-${owner}.tar`;
        const sourceBytes = readFileSync(archive);
        // OpenShell 0.1.2 caps piped command input at 4 MiB, below the transport's frame limit.
        const chunkBytes = 1048576;
        for (let offset = 0; offset < sourceBytes.length; offset += chunkBytes) {
          await run({ command: 'node', args: ['-e', 'const fs=require("fs"); const out=fs.createWriteStream(process.argv[1],{flags:process.argv[2]});process.stdin.pipe(out);', archivePath, offset === 0 ? 'wx' : 'a'], input: sourceBytes.subarray(offset, offset + chunkBytes), timeoutMs: 120000, maxOutputBytes: 65536 });
        }
        try { await run({ command: 'tar', args: ['-xf', archivePath, '--no-same-owner', '-C', `${worker.workspace}/repository`], timeoutMs: 120000, maxOutputBytes: 65536 }); }
        finally { await run({ command: 'rm', args: ['--', archivePath], timeoutMs: 20000, maxOutputBytes: 65536 }); }
      } finally { rmSync(archive, { force: true }); }
    },
    setup: (commands, setup) => request('setup', { commands, timeoutMs: setup.timeoutMs }, setup.timeoutMs + 30000, setup.signal),
    async isolate() {
      const isolated = await request<{ address: string }>('isolate', {}, 60000);
      if (!isIPv4(isolated.address)) throw Error('Invalid remote isolation address');
      return {
        address: '127.0.0.1',
        async connect(port: number) {
          await remote.forward(isolated.address, port);
          await request('connect', { port }, 60000);
          return `http://${isolated.address}:${port}`;
        },
        async close() { await remote.request('seal', {}, 60000); },
      };
    },
  };
}
