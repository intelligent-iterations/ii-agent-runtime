import { createServer, type Socket } from 'node:net';
import type { Writable } from 'node:stream';
import type { TunnelFrame } from './channel.js';

/** The listener exists only on the isolated worker bridge; traffic travels to the caller's existing gateway. */
export async function gatewayTunnel(address: string, port: number, output: Writable) {
  const sockets = new Map<number, Socket>();
  let counter = 0, closed = false;
  const send = (frame: TunnelFrame) => output.write(JSON.stringify(frame) + '\n');
  const server = createServer(socket => {
    if (closed || sockets.size >= 64) { socket.destroy(); return; }
    const id = ++counter; sockets.set(id, socket); send({ tunnel: id, kind: 'open' });
    socket.on('error', () => socket.destroy());
    socket.on('data', data => {
      if (!send({ tunnel: id, kind: 'data', data: data.toString('base64') })) { socket.pause(); output.once('drain', () => socket.resume()); }
    });
    socket.once('close', () => { sockets.delete(id); if (!closed) send({ tunnel: id, kind: 'end' }); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
  return {
    receive(frame: TunnelFrame) {
      const socket = sockets.get(frame.tunnel);
      if (!socket) return;
      if (frame.kind === 'data' && typeof frame.data === 'string') {
        const data = Buffer.from(frame.data, 'base64');
        if (socket.writableLength + data.length > 4 * 1024 * 1024) { socket.destroy(); return; }
        socket.write(data);
      }
      else if (frame.kind === 'end') socket.end();
      else throw Error('Invalid worker tunnel frame');
    },
    async close() {
      closed = true;
      for (const socket of sockets.values()) socket.destroy(); sockets.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
