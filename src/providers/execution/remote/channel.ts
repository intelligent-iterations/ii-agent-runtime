import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { MAX_FRAME_BYTES, type RemoteReply } from './protocol.js';

export interface RemoteSession {
  request<T = unknown>(operation: string, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T>;
  forward(address: string, port: number): Promise<void>;
  close(): Promise<void>;
}
export interface TunnelFrame { tunnel: number; kind: 'open' | 'data' | 'end'; data?: string }

/** Multiplex a private worker gateway over the authenticated provider command stream. No public callback endpoint. */
export function commandSession(input: Writable, output: Readable, stop: () => Promise<void>): RemoteSession {
  let counter = 0, bytes = Buffer.alloc(0), failed = false, closed = false;
  let pending: { id: number; operation: string; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let gatewayPort: number | undefined;
  const tunnels = new Map<number, Socket>();
  const send = (frame: object) => input.write(JSON.stringify(frame) + '\n');
  const fail = () => {
    failed = true;
    pending?.reject(Error('Infrastructure command stream failed')); pending = undefined;
    for (const socket of tunnels.values()) socket.destroy(); tunnels.clear();
  };
  input.on('error', fail); output.on('error', fail); output.on('end', () => { if (!closed) fail(); });
  output.on('data', (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    try {
      let end: number;
      while ((end = bytes.indexOf(10)) !== -1) {
        if (end > MAX_FRAME_BYTES) throw Error();
        const frame = JSON.parse(bytes.subarray(0, end).toString('utf8')) as RemoteReply & TunnelFrame;
        bytes = bytes.subarray(end + 1);
        if (frame.tunnel !== undefined) {
          if (!Number.isSafeInteger(frame.tunnel) || frame.tunnel < 1 || !gatewayPort) throw Error();
          if (frame.kind === 'open') {
            if (tunnels.has(frame.tunnel) || tunnels.size >= 64) throw Error();
            const socket = connect(gatewayPort, '127.0.0.1'); tunnels.set(frame.tunnel, socket);
            socket.on('error', () => socket.destroy());
            socket.on('data', data => {
              if (!send({ tunnel: frame.tunnel, kind: 'data', data: data.toString('base64') })) {
                socket.pause(); input.once('drain', () => socket.resume());
              }
            });
            socket.once('close', () => { tunnels.delete(frame.tunnel); if (!closed && !failed) send({ tunnel: frame.tunnel, kind: 'end' }); });
          } else {
            const socket = tunnels.get(frame.tunnel);
            if (!socket) continue; // An end/data frame may race local connection shutdown.
            if (frame.kind === 'data' && typeof frame.data === 'string') {
        const data = Buffer.from(frame.data, 'base64');
        if (socket.writableLength + data.length > 4 * 1024 * 1024) { socket.destroy(); continue; }
        socket.write(data);
      }
            else if (frame.kind === 'end') socket.end();
            else throw Error();
          }
        } else {
          if (!pending || frame.id !== pending.id || typeof frame.ok !== 'boolean') throw Error();
          const current = pending; pending = undefined;
          if (frame.ok) current.resolve(frame.value); else current.reject(Error(`Remote worker ${current.operation} failed`));
        }
      }
      if (bytes.length > MAX_FRAME_BYTES) throw Error();
    } catch { fail(); }
  });
  const session: RemoteSession = {
    async request<T>(operation: string, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
      if (pending || failed || closed || signal?.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('Infrastructure session unavailable');
      const frame = { id: ++counter, operation, value };
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) throw Error('Infrastructure request too large');
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<T>((resolve, reject) => {
          pending = { id: frame.id, operation, resolve: value => resolve(value as T), reject };
          timer = setTimeout(fail, timeoutMs); signal?.addEventListener('abort', fail, { once: true }); send(frame);
        });
      } finally { clearTimeout(timer!); signal?.removeEventListener('abort', fail); }
    },
    async forward(address, port) {
      if (gatewayPort || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid worker tunnel');
      gatewayPort = port;
      await session.request('forward', { address, port }, 20000);
    },
    async close() {
      if (closed) return; closed = true; fail(); input.end(); await stop();
    },
  };
  return session;
}
