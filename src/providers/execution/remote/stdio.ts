import type { TunnelFrame } from './channel.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dockerTofuTarget } from '../docker/target.js';
import { openshellTarget } from '../openshell/target.js';
import { openOpenShellHost } from './openshell-host.js';
import { executionServices } from '../../services.js';
import { MAX_FRAME_BYTES, remoteOperations, type RemoteRequest } from './protocol.js';

// Invoked only through an authenticated infrastructure session; never exposed as an HTTP service.
const provider = process.argv[2];
if (!['docker', 'openshell'].includes(provider ?? '')) throw Error('Unknown isolation provider');
const root = '/var/lib/ii-runtime';
mkdirSync(root, { recursive: true, mode: 0o700 });
const parent = mkdtempSync(join(root, 'session-'));
const tools = { parent, executablePath: process.env.PATH ?? '/usr/bin:/bin' };
const bootstrap = new AbortController();
const interruptBootstrap = () => bootstrap.abort();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, interruptBootstrap);
let openShell: Awaited<ReturnType<typeof openOpenShellHost>> | undefined;
try {
  if (provider === 'openshell') openShell = await openOpenShellHost(parent, tools.executablePath, bootstrap.signal);
} catch (error) {
  rmSync(parent, { recursive: true });
  throw error;
} finally {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.removeListener(signal, interruptBootstrap);
}
const target = openShell ? openshellTarget({ ...tools, host: openShell.host }) : dockerTofuTarget({ ...tools, services: executionServices });
const operations = remoteOperations(target);
let pending = Buffer.alloc(0);
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  try { await operations.close(); } finally { await openShell?.close(); }
  rmSync(parent, { recursive: true });
})();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().finally(() => process.exit(1)); });
let active = Promise.resolve();
let queued = 0;
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_FRAME_BYTES) throw Error('Infrastructure frame too large');
      const request = JSON.parse(pending.subarray(0, end).toString('utf8')) as RemoteRequest & TunnelFrame;
      pending = pending.subarray(end + 1);
      if (request.tunnel !== undefined) { operations.receive(request); continue; }
      if (++queued > 2) throw Error('Too many concurrent infrastructure operations');
      active = active.then(async () => {
        const reply = JSON.stringify(await operations.handle(request)) + '\n';
        if (Buffer.byteLength(reply) > MAX_FRAME_BYTES) throw Error('Infrastructure reply too large');
        process.stdout.write(reply); queued--;
        if (request.operation === 'close') { await close(); process.exit(0); }
      });
      void active.catch(() => { void close().finally(() => process.exit(1)); });
    }
    if (pending.length > MAX_FRAME_BYTES) throw Error('Infrastructure frame too large');
  }
  await active;
} finally { await close(); }
