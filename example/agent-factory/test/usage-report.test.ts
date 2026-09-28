import { createFactoryTelemetry as createTelemetryCollector } from '../src/telemetry.js';
import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { } from '@intelligent-iterations/ii-agent-runtime';
import { createUsageReporter, type UsageReport } from '../src/usage-report.js';
import { WorkStore } from '../src/store.js';
import { createGitHubJob } from '../src/github-job.js';
import { createUsageLedger } from '../src/usage-ledger.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { RetainedAttempt, InterruptedAttempt } from '../src/guest-retain.js';
async function fixture(usage: Record<string, unknown> = { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-usage-'))); const database = join(root, 'work.sqlite');
  let store = new WorkStore(database);
  const setup = { schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' }, deployment: { provider: 'tart', options: factoryTartOptions(), image: 'registry.example/image@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } };
  const task = store.submit('test', 'agent', { role: { setup, model: 'test-model' } }); const attemptId = store.claim(task.id)!;
  const context: ExecutionContext = { task, attemptId, cancelled: () => false, record: key => store.record(attemptId, key), checkpoint: (key, value) => store.checkpoint(attemptId, key, value) };
  const telemetry = join(root, 'telemetry.sqlite'); const collector = createTelemetryCollector({ database: telemetry, setup, executionId: task.id, attemptId });
  await collector.publish({ source: 'codex', kind: 'transcript', eventType: 'codex.exec.event', payload: { type: 'turn.completed', usage, text: 'Never send transcript text' } }); collector.close();
  const bytes = readFileSync(telemetry);
  const retained = { worker: { state: 'completed', telemetryComplete: true, observedUsage: true }, files: [{ path: 'telemetry.sqlite', localPath: telemetry, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] } as RetainedAttempt;
  return { root, context, retained, reopen() { store.close(); store = new WorkStore(database); }, close() { store.close(); rmSync(root, { recursive: true }); } };
}
const billing = { mode: 'metered_api' as const, provider: 'openai' };

test('retained runtime telemetry reaches a separate ledger and remains queryable after reopen', async () => {
  const f = await fixture(); const directory = join(f.root, 'accounting');
  let ledger = createUsageLedger({ directory, destinationId: 'on-prem' });
  try {
    await createUsageReporter({ destinationId: 'on-prem', billing, deliver: ledger.deliver })(f.context, f.retained);
    const receipt = f.context.record('usage:receipt') as { eventId: string };
    ledger.close(); f.reopen(); ledger = createUsageLedger({ directory, destinationId: 'on-prem' });
    assert.deepEqual(ledger.get(receipt.eventId), f.context.record('usage:report'));
    assert.deepEqual(ledger.get(receipt.eventId)?.tokens, { input: 10, cachedInput: 3, output: 4, total: 14 });
    await createUsageReporter({ destinationId: 'on-prem', billing, deliver: ledger.deliver })(f.context, f.retained);
    assert.equal(ledger.list().length, 1);
  } finally { ledger.close(); f.close(); }
});

test('usage delivery carries observed counts and explicit billing without transcript text or invented prices', async () => {
  const f = await fixture(); let report: UsageReport | undefined;
  f.context.checkpoint('workerStaging', { workloadDigest: 'sha256:' + 'c'.repeat(64) });
  try {
    const send = createUsageReporter({ destinationId: 'test', billing, deliver: async value => { report = value; return { eventId: value.eventId, receiptId: 'accepted' }; } });
    await send(f.context, f.retained); assert.ok(report);
    assert.deepEqual(report.tokens, { input: 10, cachedInput: 3, output: 4, total: 14 });
    assert.equal(report.evidence, 'complete'); assert.equal(report.model, 'test-model');
    assert.equal(report.workloadDigest, 'sha256:' + 'c'.repeat(64));
    assert.equal(report.apiEquivalentCostUsd, null); assert.equal(report.actualCostUsd, null);
    assert.ok(!JSON.stringify(report).includes('transcript text'));
    assert.ok(f.context.record('usage:receipt'));
  } finally { f.close(); }
});

test('lost HTTP acknowledgement retries the same persisted report after reopening the work database', async () => {
  const f = await fixture(); const seen = new Map<string, string>(); let calls = 0;
  const serverErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part; const report = JSON.parse(body); calls++;
      if (seen.has(report.eventId)) assert.equal(seen.get(report.eventId), body); seen.set(report.eventId, body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ eventId: report.eventId, receiptId: 'receipt-one' }));
    } catch (error) { serverErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  let loseAck = true;
  const options = { destinationId: 'test', billing, deliver: async (report: UsageReport) => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: JSON.stringify(report), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Delivery rejected');
    const receipt = await response.json() as { eventId: string; receiptId: string };
    if (loseAck) throw Error('synthetic-sensitive-response'); return receipt;
  } };
  try {
    await assert.rejects(createUsageReporter(options)(f.context, f.retained), /delivery unconfirmed/);
    assert.equal(f.context.record('usage:receipt'), null); f.reopen(); loseAck = false;
    await createUsageReporter(options)(f.context, f.retained); await createUsageReporter(options)(f.context, f.retained);
    assert.equal(calls, 2); assert.equal(seen.size, 1); assert.deepEqual(serverErrors, []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test('missing or malformed usage stays unknown instead of being reported as zero', async () => {
  const f = await fixture({ input_tokens: -1, output_tokens: 4 }); const reports: UsageReport[] = [];
  try {
    const send = createUsageReporter({ destinationId: 'test', billing: { mode: 'unknown', provider: 'openai' }, deliver: async report => { reports.push(report); return { eventId: report.eventId, receiptId: 'receipt' }; } });
    await send(f.context, f.retained); assert.equal(reports[0]!.tokens, null); assert.equal(reports[0]!.evidence, 'missing'); assert.equal(reports[0]!.actualCostUsd, null);
  } finally { f.close(); }
  const missing = await fixture();
  try {
    const retained: InterruptedAttempt = { interrupted: true, conclusion: 'cancelled', files: [], missingMetadata: ['telemetry.sqlite'], outputGaps: [], sealedManifest: false };
    await createUsageReporter({ destinationId: 'test', billing, deliver: async report => { assert.equal(report.tokens, null); assert.equal(report.outcome, 'interrupted'); return { eventId: report.eventId, receiptId: 'receipt' }; } })(missing.context, retained);
  } finally { missing.close(); }
});

test('wrong acknowledgement and changed destination cannot release the reporting gate', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createUsageReporter({ destinationId: 'one', billing, deliver: async () => ({ eventId: 'wrong', receiptId: 'receipt' }) })(f.context, f.retained), /acknowledgement mismatch/);
    assert.equal(f.context.record('usage:receipt'), null);
    await assert.rejects(createUsageReporter({ destinationId: 'two', billing, deliver: async () => { throw Error('Must not send'); } })(f.context, f.retained), /configuration changed/);
  } finally { f.close(); }
});

test('unacknowledged usage blocks workflow reconciliation until the persisted report is delivered', async () => {
  const f = await fixture(); let available = false; let sends = 0;
  const reportUsage = createUsageReporter({ destinationId: 'test', billing, deliver: async report => {
    sends++; if (!available) throw Error('Destination unavailable');
    return { eventId: report.eventId, receiptId: 'accepted', privateResponse: 'must-not-persist' };
  } });
  const commit = 'a'.repeat(40);
  const runner = { runnerId: 42, intent: { schemaVersion: 1 as const, repository: 'org/repo', operationId: 'operation', name: 'runner', ownershipLabel: 'owned', groupId: 1, workFolder: '_work' } };
  const resource = { manifestPath: '/operator/manifest.json', runner };
  f.context.checkpoint('manifestPath', resource.manifestPath); f.context.checkpoint('runnerReceipt', runner);
  const job = createGitHubJob({ repository: 'org/repo', workflowId: 3, ref: 'v1', commit,
    stage: async () => {}, retain: async context => { await reportUsage(context, f.retained); return f.retained; },
    verify: async () => { throw Error('No acceptance before reporting'); },
    transport: { request: async (_method, path) => {
      if (path.endsWith('/dispatches')) return { status: 200, body: { workflow_run_id: 7 } };
      if (path.endsWith('/runs/7')) return { status: 200, body: { id: 7, workflow_id: 3, head_sha: commit,
        display_title: `factory-${f.context.attemptId}`, event: 'workflow_dispatch', run_attempt: 1,
        repository: { full_name: 'org/repo' }, status: 'completed', conclusion: 'failure' } };
      throw Error('Unexpected request');
    } },
  });
  try {
    await assert.rejects(job.run(f.context, resource, async () => {}), /delivery unconfirmed/);
    f.reopen();
    await assert.rejects(job.reconcile(f.context), /delivery unconfirmed/);
    assert.equal(f.context.record('workflowTerminal'), null);
    assert.equal(f.context.record('workflowRetained'), null);
    available = true; await job.reconcile(f.context);
    assert.ok(f.context.record('workflowTerminal'));
    assert.ok(f.context.record('workflowRetained'));
    assert.equal(sends, 3);
    assert.deepEqual(Object.keys(f.context.record('usage:receipt') as object).sort(), ['eventId', 'receiptId']);
  } finally { f.close(); }
});
