import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { isIPv4 } from 'node:net';
import type { InstallationToken } from './github-app.js';

function authenticated(header: string | undefined, secret: string): boolean {
  let candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (header?.startsWith('Basic ')) {
    const basic = Buffer.from(header.slice(6), 'base64').toString('utf8');
    if (basic.startsWith('agent:')) candidate = basic.slice(6);
  }
  const bytes = Buffer.from(candidate);
  return bytes.length === secret.length && timingSafeEqual(bytes, Buffer.from(secret));
}
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Error('Request body limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Repository and model reverse proxy. No upstream credentials, cookies or redirects reach the worker. */
export async function openWorkerGateway(options: {
  address: string;
  grants: InstallationToken[];
  model: { respond(input: unknown): Promise<Response> };
  signal: AbortSignal;
  fetch?: typeof fetch;
}) {
  if (!isIPv4(options.address) || options.address === '0.0.0.0') throw Error('Gateway must bind a specific IPv4 interface');
  const grants = new Map(options.grants.map(grant => [grant.repository.toLowerCase(), grant]));
  if (!grants.size || grants.size > 11 || grants.size !== options.grants.length) throw Error('Invalid gateway grants');
  for (const [repository, grant] of grants) if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !grant.token) throw Error('Invalid gateway grant');
  const token = randomBytes(32).toString('hex');
  const fetcher = options.fetch ?? fetch;
  let requests = 0;
  let transferred = 0;
  let active = 0;
  let host = '';
  const pending = new Set<Promise<void>>();
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const server = createServer((request, response) => {
    const operation = (async () => {
      const reject = (status: number) => {
        response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('Agent gateway request denied.');
      };
      if (++requests > 1000 || active >= 8 || transferred >= 268435456) { reject(429); return; }
      if (signal.aborted || request.headers.host !== host || !authenticated(request.headers.authorization, token)) { reject(403); return; }
      active++;
      try {
        const raw = request.url ?? '';
        if (raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//') || /[%\\#\r\n]/.test(raw.split('?')[0]!) ||
          raw.split('?')[0]!.split('/').some(segment => segment === '.' || segment === '..')) throw Error('Invalid route');
        const url = new URL(raw, `http://${host}`);
        if (url.pathname.split('/').some(segment => segment === '.' || segment === '..')) throw Error('Invalid route');
        const method = request.method ?? '';
        let upstream: Response;
        if (url.pathname === '/v1/responses' && method === 'POST' && !url.search) {
          if (request.headers['content-encoding']) throw Error('Encoded model input not supported');
          const payload = await body(request, 1048576);
          transferred += payload.length;
          upstream = await options.model.respond(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)));
        } else {
          const match = /^\/(git|github)\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)(\/.*)?$/.exec(url.pathname);
          if (!match) throw Error('Unsupported route');
          const kind = match[1];
          const repositoryName = kind === 'git' ? match[3]!.replace(/\.git$/, '') : match[3]!;
          const repository = `${match[2]}/${repositoryName}`.toLowerCase();
          const grant = grants.get(repository);
          const suffix = match[4] ?? '';
          if (!grant || Date.parse(grant.expiresAt) <= Date.now() + 10000) throw Error('Repository access unavailable');
          if (kind === 'git') {
            if (!((method === 'GET' && suffix === '/info/refs' && ['?service=git-upload-pack', '?service=git-receive-pack'].includes(url.search)) ||
              (method === 'POST' && ['/git-upload-pack', '/git-receive-pack'].includes(suffix) && !url.search))) throw Error('Unsupported Git request');
            if ((suffix === '/git-receive-pack' || url.search.includes('git-receive-pack')) && grant.permissions.contents !== 'write') throw Error('Repository is read-only');
          } else {
            if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !suffix ||
              (method === 'POST' && /^\/issues\/?$/.test(suffix))) throw Error('Unsupported repository request');
          }
          const payload = await body(request, 16777216);
          transferred += payload.length;
          if (transferred > 268435456) throw Error('Transfer limit');
          const destination = kind === 'git' ? `https://github.com/${repository}.git${suffix}${url.search}` :
            `https://api.github.com/repos/${repository}${suffix}${url.search}`;
          const headers: Record<string, string> = {
            authorization: kind === 'git' ? `Basic ${Buffer.from(`x-access-token:${grant.token}`).toString('base64')}` : `Bearer ${grant.token}`,
            accept: kind === 'git' ? '*/*' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          };
          if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
          if (request.headers['content-encoding']) headers['content-encoding'] = request.headers['content-encoding'];
          if (request.headers['git-protocol']) headers['git-protocol'] = String(request.headers['git-protocol']);
          upstream = await fetcher(destination, { method, headers, redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
            ...(payload.length ? { body: new Uint8Array(payload) } : {}) });
        }
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
        const reader = upstream.body?.getReader();
        if (reader) {
          let size = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length; transferred += chunk.value.length;
              if (size > 67108864 || transferred > 268435456 || signal.aborted) throw Error('Response transfer limit');
              if (!response.write(chunk.value)) await once(response, 'drain', { signal });
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        response.end();
      } catch {
        if (response.headersSent) response.destroy();
        else reject(502);
      } finally { active--; }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.listen(0, options.address);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Gateway bind failed');
  host = `${options.address}:${address.port}`;
  let closed: Promise<void> | undefined;
  return {
    endpoint: `http://${host}`, port: address.port, token,
    snapshot: () => ({ requests, transferredBytes: transferred }),
    close: () => closed ??= (async () => {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled(pending);
    })(),
  };
}
