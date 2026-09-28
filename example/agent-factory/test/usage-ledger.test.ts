import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageLedger } from '../src/usage-ledger.js';
import type { UsageReport } from '../src/usage-report.js';

const report: UsageReport = { schemaVersion: 1, eventId: 'a'.repeat(64), executionId: 'task', attemptId: 'attempt', setupDigest: 'b'.repeat(64), workloadDigest: null,
  destinationId: 'on-prem', billing: { mode: 'unknown', provider: 'openai' }, model: null, modelSource: 'unknown', outcome: 'interrupted',
  evidence: 'missing', observedTurns: 0, tokens: null, apiEquivalentCostUsd: null, actualCostUsd: null };
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'factory-ledger-')));

test('committed usage survives reporter SIGKILL and replays without duplicate accounting', async () => {
  const root = temporary(); const directory = join(root, 'accounting');
  try {
    const source = `import { createUsageLedger } from ${JSON.stringify(new URL('../dist/usage-ledger.js', import.meta.url).href)};
      const ledger = createUsageLedger(${JSON.stringify({ directory, destinationId: 'on-prem' })});
      const receipt = await ledger.deliver(${JSON.stringify(report)});
      process.stdout.write(JSON.stringify(receipt), () => process.kill(process.pid, 'SIGKILL'));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const receipt = JSON.parse(child.stdout);
    const ledger = createUsageLedger({ directory, destinationId: 'on-prem' });
    try {
      assert.deepEqual(ledger.get(report.eventId), report);
      assert.deepEqual(await ledger.deliver(report), receipt);
      assert.equal(ledger.list().length, 1);
      assert.equal(statSync(join(directory, 'usage.sqlite')).mode & 0o777, 0o600);
      await assert.rejects(ledger.deliver({ ...report, outcome: 'failed' }), /different content/);
      assert.deepEqual(ledger.get(report.eventId), report);
    } finally { ledger.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

test('destination binding and private directory prevent accidental cross-installation accounting', async () => {
  const root = temporary();
  try {
    const directory = join(root, 'accounting'); const ledger = createUsageLedger({ directory, destinationId: 'on-prem' });
    try {
      await assert.rejects(ledger.deliver({ ...report, destinationId: 'another' }), /Invalid/);
      assert.deepEqual(ledger.list(), []);
      assert.throws(() => ledger.list(1001), /limit/);
    } finally { ledger.close(); }
    assert.throws(() => createUsageLedger({ directory, destinationId: 'another' }), /destination changed/);
    symlinkSync(directory, join(root, 'link'));
    assert.throws(() => createUsageLedger({ directory: join(root, 'link'), destinationId: 'on-prem' }), /private directory/);
    chmodSync(directory, 0o755);
    assert.throws(() => createUsageLedger({ directory, destinationId: 'on-prem' }), /private directory/);
  } finally { rmSync(root, { recursive: true }); }
});
