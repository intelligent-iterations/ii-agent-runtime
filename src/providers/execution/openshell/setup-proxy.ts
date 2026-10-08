import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { connect, isIPv4, type Socket } from 'node:net';

/** Deliberately IPv4-only: unknown/special address families fail closed. */
export function publicSetupAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

/** Validate every answer, then connect to the validated literal; never resolve again at connect time. */
export async function resolveSetupDestination(host: string, resolve: (host: string) => Promise<string[]> = host => new Resolver({ timeout: 3000, tries: 1 }).resolve4(host)): Promise<string> {
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw Error('Setup destination denied');
  const addresses = isIPv4(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(item => !publicSetupAddress(item))) throw Error('Setup destination denied');
  return addresses[0]!;
}

/** Ephemeral, authenticated HTTP(S) package egress. No host or provider credentials are forwarded. */
export async function openSetupProxy(address: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const resolve = (host: string) => resolver.resolve4(host);
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Basic ${Buffer.from(`setup:${token}`).toString('base64')}`);
  const sockets = new Set<Socket>();
  let closed = false, requests = 0, bytes = 0;
  const stop = () => {
    closed = true;
    resolver.cancel();
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const track = (socket: Socket) => {
    if (closed || sockets.size >= 64) { socket.destroy(); return false; }
    sockets.add(socket);
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => { bytes += data.length; if (bytes > 512 * 1048576) stop(); });
    return true;
  };
  const admitted = (value: string | undefined) => {
    const actual = Buffer.from(value ?? '');
    return !closed && ++requests <= 4096 && actual.length === authorization.length && timingSafeEqual(actual, authorization);
  };
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, (request, response) => {
    void (async () => {
      if (!admitted(request.headers['proxy-authorization'])) throw Error('denied');
      const url = new URL(request.url ?? '');
      if (url.protocol !== 'http:' || url.username || url.password || (url.port && url.port !== '80')) throw Error('denied');
      const ip = await resolveSetupDestination(url.hostname, resolve);
      if (closed || request.destroyed) throw Error('closed');
      // Rebuild hop-by-hop headers, including names nominated by Connection.
      const headers: OutgoingHttpHeaders = { ...request.headers, host: url.host };
      for (const key of ['connection', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(request.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim())]) delete headers[key];
      const upstream = httpRequest({ host: ip, port: 80, method: request.method, path: url.pathname + url.search, headers, agent: false }, incoming => {
        const outgoing = { ...incoming.headers };
        for (const key of ['connection', 'keep-alive', 'proxy-authenticate', 'upgrade', ...(incoming.headers.connection ?? '').toLowerCase().split(',').map(x => x.trim())]) delete outgoing[key];
        response.writeHead(incoming.statusCode ?? 502, outgoing);
        incoming.pipe(response);
      });
      upstream.on('socket', track);
      upstream.on('error', () => response.destroy());
      response.on('close', () => upstream.destroy());
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    })().catch(() => { if (!response.headersSent) response.writeHead(403); response.end(); });
  });
  server.on('connection', track);
  server.on('connect', (request, stream, head) => {
    const client = stream as Socket;
    void (async () => {
      if (!admitted(request.headers['proxy-authorization'])) throw Error('denied');
      const match = /^([a-zA-Z0-9.-]{1,253}):443$/.exec(request.url ?? '');
      if (!match) throw Error('denied');
      const ip = await resolveSetupDestination(match[1]!, resolve);
      if (closed || client.destroyed) throw Error('closed');
      const upstream = connect({ host: ip, port: 443 });
      if (!track(upstream)) { client.destroy(); return; }
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  if (signal.aborted) throw Error('Setup canceled');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) { stop(); throw Error('Setup canceled'); }
  const port = (server.address() as { port: number }).port;
  return { port, url: `http://setup:${token}@${address}:${port}`, close() { signal.removeEventListener('abort', stop); stop(); } };
}
