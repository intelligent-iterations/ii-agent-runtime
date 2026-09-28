import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLedger } from '../src/access-ledger.js';
import { assessCapabilityGrant } from '@intelligent-iterations/ii-agent-runtime';

test('grant history survives reopening without credential bytes', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-access-')));
  chmodSync(directory, 0o700);
  try {
    let ledger = createAccessLedger(directory);
    const id = ledger.request({ provider: 'github-app', recipient: 'agent:attempt-1', resource: 'org/repo',
      capabilities: ['contents:read'], authorizedBy: 'octocat', issuedBy: 'factory-host', policyRevision: 'abc123',
      attemptId: 'attempt-1', credentialReference: 'app:1:source' });
    ledger.append({ eventId: `${id}:issued`, grantId: id, kind: 'issued', at: '2026-09-28T10:00:00.000Z',
      capabilities: ['contents:read'], expiresAt: '2026-09-28T11:00:00.000Z' });
    ledger.append({ eventId: `${id}:seen`, grantId: id, kind: 'observed', at: '2026-09-28T10:01:00.000Z',
      observation: 'verified', evidenceId: 'github-installation:1' });
    ledger.close();
    ledger = createAccessLedger(directory);
    const [grant] = ledger.current();
    assert.equal(grant?.recipient, 'agent:attempt-1');
    assert.equal(grant?.policyRevision, 'abc123');
    assert.equal(grant?.attemptId, 'attempt-1');
    assert.equal(grant?.grantedAt, '2026-09-28T10:00:00.000Z');
    assert.deepEqual(assessCapabilityGrant(grant!, new Date('2026-09-28T10:02:00.000Z'), 120_000), []);
    assert.deepEqual(assessCapabilityGrant(grant!, new Date('2026-09-28T11:01:00.000Z'), 120_000).map(f => f.reason), ['expired', 'stale']);
    assert.throws(() => ledger.append({ eventId: `${id}:issued`, grantId: id, kind: 'issued', at: '2026-09-28T10:00:00.000Z',
      capabilities: ['contents:write'] }), /already used/);
    assert.doesNotMatch(readFileSync(join(directory, 'access.sqlite')).toString(), /synthetic-token-value/);
    ledger.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
