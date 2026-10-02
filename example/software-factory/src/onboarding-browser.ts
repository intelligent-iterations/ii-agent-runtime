import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { PRODUCT_NAME } from './identity.js';

export interface BrowserSession {
  startUrl: string;
  manifest: Record<string, unknown>;
  code: Promise<string>;
  installation: Promise<number>;
  close(): Promise<void>;
}
const submitScript = 'document.forms[0].submit()';
const submitHash = createHash('sha256').update(submitScript).digest('base64');
const html = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** GitHub rejects App names longer than 34 characters, so long organization names are cut to fit. */
export const appName = (organization: string) => `${PRODUCT_NAME} - ${organization}`.slice(0, 34).replace(/[\s-]+$/, '');

/** Browser redirects terminate on loopback; this is not a public webhook receiver. */
/**
 * What the App may do. Contents write includes read, which the hub's pull request token also needs: GitHub refuses to open
 * a pull request with 422 "not all refs are readable" when the token cannot read contents.
 */
export const APP_PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } as const;

export async function openOnboardingBrowser(organization: string, options: { timeoutMs?: number; port?: number } = {}): Promise<BrowserSession> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(organization)) throw Error('Invalid organization');
  const timeout = options.timeoutMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 55 * 60 * 1000) throw Error('Invalid onboarding timeout');
  // A fixed port lets a remote operator forward the loopback callback (for example with ssh -L).
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw Error('Invalid callback port');
  const nonce = randomBytes(32).toString('hex');
  const state = randomBytes(32).toString('hex');
  const codeResult = Promise.withResolvers<string>();
  const installResult = Promise.withResolvers<number>();
  // Both promises may reject while the caller is performing a different onboarding step.
  void codeResult.promise.catch(() => {}); void installResult.promise.catch(() => {});
  let codeReceived = false;
  let installationReceived = false;
  let requests = 0;
  let base = '';
  let manifest: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', `default-src 'none'; form-action https://github.com; script-src 'sha256-${submitHash}'; frame-ancestors 'none'`);
    const finish = (status: number, text: string) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); };
    if (++requests > 40 || request.method !== 'GET' || request.headers.host !== new URL(base).host ||
      request.socket.remoteAddress !== '127.0.0.1' || (request.url?.length ?? 0) > 2048) return finish(400, 'Invalid onboarding request.');
    const url = new URL(request.url ?? '/', base);
    if (url.pathname === `/${nonce}/start`) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.write(`<!doctype html><meta charset="utf-8"><title>Connect GitHub</title><form method="post" action="https://github.com/organizations/${html(organization)}/settings/apps/new?state=${html(state)}"><input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`);
      response.end('<script>document.forms[0].submit()</script>');
    } else if (url.pathname === `/${nonce}/created`) {
      const provided = Buffer.from(url.searchParams.get('state') ?? '');
      const code = url.searchParams.get('code') ?? '';
      if (codeReceived || provided.length !== state.length || !timingSafeEqual(provided, Buffer.from(state)) || !/^[a-zA-Z0-9_-]{10,256}$/.test(code)) return finish(400, 'Invalid or expired callback.');
      codeReceived = true; codeResult.resolve(code);
      finish(200, 'App creation received. Return to the terminal to continue.');
    } else if (url.pathname === `/${nonce}/installed`) {
      const raw = url.searchParams.get('installation_id') ?? '';
      const id = Number(raw);
      if (!codeReceived || installationReceived || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id) || url.searchParams.get('setup_action') !== 'install') return finish(400, 'Invalid or expired installation callback.');
      installationReceived = true; installResult.resolve(id);
      finish(200, 'Installation received. Return to the terminal for verification.');
    } else finish(404, 'Unknown onboarding session.');
  });
  server.maxHeadersCount = 30;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Cannot open local callback');
  base = `http://127.0.0.1:${address.port}`;
  manifest = {
    name: appName(organization), url: `https://github.com/${organization}`, public: false,
    redirect_url: `${base}/${nonce}/created`, setup_url: `${base}/${nonce}/installed`,
    hook_attributes: { url: `https://github.com/${organization}`, active: false },
    default_permissions: APP_PERMISSIONS,
    default_events: [], request_oauth_on_install: false,
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    clearTimeout(timer);
    codeResult.reject(Error('Onboarding session closed')); installResult.reject(Error('Onboarding session closed'));
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  });
  const timer = setTimeout(() => { void close(); }, timeout);
  timer.unref();
  return { startUrl: `${base}/${nonce}/start`, manifest, code: codeResult.promise, installation: installResult.promise, close };
}
