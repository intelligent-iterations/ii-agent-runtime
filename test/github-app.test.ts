import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { test } from 'node:test';
import { appJwt, createInstallationIssuer } from '../src/providers/github-app.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const now = Date.parse('2026-09-29T12:00:00Z');
test('App JWT is independently signature-verifiable and bounded in lifetime', () => {
  const jwt = appJwt(100, pem, now);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.equal(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(keys.publicKey, Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, 100);
  assert.ok(claims.exp - claims.iat < 600);
  assert.throws(() => appJwt(100, 'sentinel-secret', now), error => error instanceof Error && !error.message.includes('sentinel'));
});

test('each repository gets a separate exact-scope token and broader responses are revoked', async () => {
  const bodies: any[] = [];
  const revoked: string[] = [];
  let broaden = false;
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/app') return Response.json({ id: 100, owner: { type: 'Organization', login: 'example' } });
    if (path === '/app/installations/200') return Response.json({ id: 200, app_id: 100, account: { type: 'Organization', login: 'example' }, suspended_at: null, repository_selection: 'all' });
    if (path === '/app/installations/200/access_tokens') {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return Response.json({ token: `synthetic-${body.repositories[0]}-${bodies.length}`, expires_at: '2026-09-29T13:00:00Z',
        repositories: [{ id: 101, full_name: `example/${body.repositories[0]}` }],
        permissions: { metadata: 'read', ...body.permissions, ...(broaden ? { administration: 'write' } : {}) } }, { status: 201 });
    }
    if (path === '/installation/token') { revoked.push(new Headers(init?.headers).get('authorization')!); return new Response(null, { status: 204 }); }
    throw Error('Unexpected request');
  };
  const issuer = createInstallationIssuer({ appId: 100, installationId: 200, owner: 'example', requireAppOwner: true, privateKey: () => pem, fetch: transport, now: () => now });
  await issuer.issue('example/project', { contents: 'write' });
  await issuer.issue('example/library', { contents: 'read' });
  assert.deepEqual(bodies, [ { repositories: ['project'], permissions: { contents: 'write' } }, { repositories: ['library'], permissions: { contents: 'read' } } ]);
  broaden = true;
  await assert.rejects(issuer.issue('example/library', { contents: 'read' }), /TOKEN_SCOPE/);
  assert.equal(revoked.length, 1);
  await issuer.close(); assert.equal(revoked.length, 3);
  await assert.rejects(issuer.issue('another/project', { contents: 'read' }), /REPOSITORY/);
});

test('suspended installations cannot mint tokens; revocation failures remain visible', async () => {
  let suspended = true;
  const transport: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/app') return Response.json({ id: 100, owner: { type: 'Organization', login: 'example' } });
    if (path === '/app/installations/200') return Response.json({ id: 200, app_id: 100, account: { type: 'Organization', login: 'example' }, suspended_at: suspended ? '2026-09-29' : null, repository_selection: 'selected' });
    if (path === '/app/installations/200/access_tokens') return Response.json({ token: 'synthetic-token', expires_at: '2026-09-29T13:00:00Z', repositories: [{ id: 101, full_name: 'example/project' }], permissions: { contents: 'read' } }, { status: 201 });
    return new Response(null, { status: 503 });
  };
  const issuer = createInstallationIssuer({ appId: 100, installationId: 200, owner: 'example', requireAppOwner: true, privateKey: () => pem, fetch: transport, now: () => now });
  await assert.rejects(issuer.issue('example/project', { contents: 'read' }), /INSTALLATION/);
  suspended = false;
  await issuer.issue('example/project', { contents: 'read' });
  await assert.rejects(issuer.close(), /REVOCATION_UNCONFIRMED/);
});

test('an App owned elsewhere may serve an installation on an organization or a user, unless the App must belong to that owner', async () => {
  for (const [accountType, requireAppOwner, expected] of [['Organization', false, true], ['User', false, true], ['Organization', true, false], ['Bot', false, false]] as const) {
    const transport: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      // A vendor's App, installed on the customer's account.
      if (path === '/app') return Response.json({ id: 100, owner: { type: 'Organization', login: 'vendor' } });
      if (path === '/app/installations/200') return Response.json({ id: 200, app_id: 100, account: { type: accountType, login: 'customer' }, suspended_at: null, repository_selection: 'selected' });
      if (path === '/app/installations/200/access_tokens') return Response.json({ token: 'synthetic-token', expires_at: '2026-09-29T13:00:00Z',
        repositories: [{ id: 101, full_name: 'customer/project' }], permissions: JSON.parse(String(init?.body)).permissions }, { status: 201 });
      if (path === '/installation/token') return new Response(null, { status: 204 });
      throw Error('Unexpected request');
    };
    const issuer = createInstallationIssuer({ appId: 100, installationId: 200, owner: 'customer', requireAppOwner, privateKey: () => pem, fetch: transport, now: () => now });
    const issued = issuer.issue('customer/project', { contents: 'write' });
    if (expected) assert.equal((await issued).repository, 'customer/project', `${accountType} ${requireAppOwner}`);
    else await assert.rejects(issued, /APP_OWNER|INSTALLATION/, `${accountType} ${requireAppOwner}`);
    await issuer.close();
  }
});
