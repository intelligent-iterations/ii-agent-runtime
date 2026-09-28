import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLedger } from '../src/access-ledger.js';
import { createGitHubApp, type GitHubAppConfig } from '../src/github-app.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const config: GitHubAppConfig = { appId: 11, key: { kind: 'keychain', service: 'test', account: 'test' },
  revision: 'policy-1', approvedBy: 'octocat', repositories: { 'org/a': { id: 101, permissions: { contents: 'write' } } } };

test('App issuance narrows repositories and permissions, then revokes after use', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-app-')));
  chmodSync(directory, 0o700);
  const ledger = createAccessLedger(directory);
  ledger.recordInstallation({ eventId: 'delivery:1', repository: 'org/a', installationId: 55, action: 'granted',
    actor: 'octocat', at: '2026-09-28T00:00:00.000Z', observedAt: '2026-09-28T00:00:01.000Z',
    source: 'signed_webhook', evidenceId: 'github-delivery:delivery' });
  const requests: Array<{ url: string; body?: unknown }> = [];
  let installationUpdatedAt = '2026-09-28T00:00:00Z';
  try {
    const app = createGitHubApp(config, ledger, { privateKey: () => privateKey, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/app/hook/deliveries') return Response.json([]);
      if (path === '/repos/org/a/installation') return Response.json({ id: 55, updated_at: installationUpdatedAt,
        suspended_at: null, repository_selection: 'selected' });
      if (path === '/app/installations/55/access_tokens') return Response.json({ token: 'synthetic-token-value',
        expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'read' }, repositories: [{ id: 101 }] }, { status: 201 });
      if (path === '/installation/token') return new Response(null, { status: 204 });
      throw Error('Unexpected endpoint');
    } });
    await app.withToken({ repository: 'org/a', permissions: { contents: 'read' }, purpose: 'source', recipient: 'host:source' },
      async token => { assert.equal(token, 'synthetic-token-value'); });
    assert.deepEqual(requests.find(item => item.url === '/app/installations/55/access_tokens')?.body,
      { repository_ids: [101], permissions: { contents: 'read' } });
    assert.equal(ledger.current()[0]?.endedAt !== null, true);
    assert.equal(ledger.events().some(event => JSON.stringify(event).includes('synthetic-token-value')), false);
    await assert.rejects(app.issue({ repository: 'org/b', permissions: { contents: 'read' }, purpose: 'source', recipient: 'host:source' }), /not approved/);
    installationUpdatedAt = '2026-09-28T01:00:00Z';
    await assert.rejects(app.issue({ repository: 'org/a', permissions: { contents: 'read' }, purpose: 'source', recipient: 'host:source' }), /could not be confirmed/);
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('App issuance recovers the installation actor from its own webhook deliveries', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-app-delivery-')));
  chmodSync(directory, 0o700);
  const ledger = createAccessLedger(directory);
  try {
    const app = createGitHubApp(config, ledger, { privateKey: () => privateKey, fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/app/hook/deliveries') return Response.json([{ id: 42, event: 'installation_repositories' }]);
      if (path === '/app/hook/deliveries/42') return Response.json({ id: 42, event: 'installation_repositories',
        delivered_at: '2026-09-28T10:00:00Z', request: { payload: { action: 'added', installation: { id: 55 },
          sender: { login: 'installing-admin' }, repositories_added: [{ full_name: 'org/a' }], repositories_removed: [] } } });
      if (path === '/repos/org/a/installation') return Response.json({ id: 55, updated_at: '2026-09-28T09:59:59Z',
        suspended_at: null, repository_selection: 'selected' });
      if (path === '/app/installations/55/access_tokens') return Response.json({ token: 'synthetic-token-value',
        expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'read' }, repositories: [{ id: 101 }] }, { status: 201 });
      throw Error(`Unexpected endpoint ${path}`);
    } });
    const grant = await app.issue({ repository: 'org/a', permissions: { contents: 'read' }, purpose: 'source', recipient: 'host:source' });
    assert.equal(ledger.current().find(item => item.id === grant.grantId)?.authorizedBy, 'installing-admin');
    assert.equal(ledger.latestInstallation('org/a')?.source, 'app_delivery');
    assert.equal(ledger.installationEvents().length, 1);
    await app.syncDeliveries();
    assert.equal(ledger.installationEvents().length, 1);
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
