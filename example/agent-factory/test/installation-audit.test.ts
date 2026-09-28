import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLedger } from '../src/access-ledger.js';
import { ingestInstallationWebhook, ingestAppDelivery } from '../src/installation-audit.js';

test('only signed installation changes establish the granting actor', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-install-audit-')));
  chmodSync(directory, 0o700);
  const ledger = createAccessLedger(directory);
  try {
    const body = Buffer.from(JSON.stringify({ action: 'added', installation: { id: 55, updated_at: '2026-09-28T09:59:59Z' }, sender: { login: 'octocat' },
      repositories_added: [{ full_name: 'org/a' }], repositories_removed: [] }));
    const input = { body, secret: 'webhook-secret', signature: 'sha256=' + createHmac('sha256', 'webhook-secret').update(body).digest('hex'),
      event: 'installation_repositories', deliveryId: 'delivery-1', receivedAt: new Date('2026-09-28T10:00:00.000Z') };
    assert.throws(() => ingestInstallationWebhook(ledger, { ...input, body: Buffer.from(body.toString().replace('octocat', 'attacker')) }), /signature/);
    assert.equal(ledger.latestInstallation('org/a'), null);
    assert.equal(ingestInstallationWebhook(ledger, input), 1);
    assert.equal(ledger.latestInstallation('org/a')?.actor, 'octocat');
    assert.equal(ledger.latestInstallation('org/a')?.at, '2026-09-28T09:59:59.000Z');
    assert.equal(ledger.latestInstallation('org/a')?.observedAt, '2026-09-28T10:00:00.000Z');
    assert.equal(ledger.latestInstallation('org/a')?.source, 'signed_webhook');
    assert.equal(ingestInstallationWebhook(ledger, input), 1);
    assert.equal(ledger.installationEvents().length, 1);
    const removed = Buffer.from(JSON.stringify({ action: 'removed', installation: { id: 55 }, sender: { login: 'octocat' },
      repositories_added: [], repositories_removed: [{ full_name: 'org/a' }] }));
    ingestInstallationWebhook(ledger, { ...input, body: removed, deliveryId: 'delivery-2',
      signature: 'sha256=' + createHmac('sha256', 'webhook-secret').update(removed).digest('hex') });
    assert.equal(ledger.latestInstallation('org/a')?.action, 'removed');
    const payload = { action: 'added', installation: { id: 55 }, sender: { login: 'maintainer' },
      repositories_added: [{ full_name: 'org/a' }], repositories_removed: [] };
    assert.equal(ingestAppDelivery(ledger, { id: 42, event: 'installation_repositories', delivered_at: '2026-09-28T11:00:00Z',
      request: { payload, headers: { 'X-GitHub-Delivery': 'delivery-42' } } }), 1);
    assert.equal(ledger.latestInstallation('org/a')?.actor, 'maintainer');
    assert.equal(ledger.latestInstallation('org/a')?.source, 'app_delivery');
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
