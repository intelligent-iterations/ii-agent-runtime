import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetryCollector as createCollector, createSqliteTelemetryStore, type TelemetryOptions, type TelemetrySink, type TelemetryRecord } from '../src/index.js';

function createTelemetryCollector(options: Omit<TelemetryOptions, 'openStore'> & { database: string }) {
  const { database, ...input } = options;
  return createCollector({ ...input, openStore: () => createSqliteTelemetryStore(database) });
}

const setup = { schemaVersion: 1, id: 'worker', revision: 'one', harness: { name: 'codex', version: '0.156.1' },
  deployment: { provider: 'tart', image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['result.json'] } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-telemetry-'));
  return { root, options: { database: join(root, 'events.sqlite'), setup, executionId: 'run-one', attemptId: 'attempt-one' }, close() { rmSync(root, { recursive: true }); } };
}

test('imported store persists correlated events and deduplicates within, but not across, attempts', async () => {
  const f = fixture(); let collector = createTelemetryCollector(f.options);
  try {
    const event = { source: 'codex' as const, kind: 'transcript' as const, eventType: 'codex.test', dedupKey: 'line:1', payload: { value: 42 } };
    assert.equal((await collector.publish(event)).accepted, true);
    assert.equal((await collector.publish(event)).accepted, false);
    collector.close(); collector = createTelemetryCollector({ ...f.options, attemptId: 'attempt-two' });
    assert.equal((await collector.publish(event)).accepted, true);
    const records = collector.events();
    assert.equal(records.length, 2);
    assert.deepEqual(new Set(records.map(record => (record.payload as any).runtime.attemptId)), new Set(['attempt-one', 'attempt-two']));
    assert.ok(records.every(record => (record.payload as any).runtime.setupDigest === collector.correlation.setupDigest));
  } finally { collector.close(); f.close(); }
});

test('literal secrets and named credentials never reach SQLite or destination envelopes', async () => {
  const f = fixture(); const secret = 'test-secret-12345'; const observed: unknown[] = [];
  const sink: TelemetrySink = { name: 'consumer', async publish(record, envelope) { observed.push(record, envelope); return { sink: 'consumer', ok: true }; } };
  const collector = createTelemetryCollector({ ...f.options, secretValues: [secret], sinks: [sink] });
  try {
    await collector.publish({ source: 'codex', kind: 'transcript', eventType: 'codex.output', dedupKey: `file:${secret}`,
      payload: { text: secret, repeated: secret, nested: [secret, secret], authorization: 'Bearer another-credential', safe: 'hello' } });
    assert.ok(!JSON.stringify(observed).includes(secret));
    assert.ok(!JSON.stringify(observed).includes('another-credential'));
    assert.match(JSON.stringify(observed), /hello/);
    for (const file of readdirSync(f.root)) assert.ok(!readFileSync(join(f.root, file)).includes(Buffer.from(secret)), file);
  } finally { collector.close(); f.close(); }
});

test('destination exceptions cannot expose credentials or prevent local persistence', async () => {
  const f = fixture();
  const collector = createTelemetryCollector({ ...f.options, sinks: [
    { name: 'throwing', async publish() { throw Error('secret-exception'); } },
    { name: 'rejecting', async publish() { return { sink: 'rejecting', ok: false, error: 'secret-body' }; } },
  ] });
  try {
    const result = await collector.publish({ source: 'agent', kind: 'hook', eventType: 'run.failed', payload: { exit: 1 } });
    assert.equal(result.accepted, true);
    assert.equal(collector.events().length, 1);
    assert.ok(result.sinkResults.every(sink => !sink.ok));
    assert.ok(!JSON.stringify(result).includes('secret-'));
  } finally { collector.close(); f.close(); }
});

test('imported Codex adapter preserves native token observations and replay identity', async () => {
  const f = fixture(); const collector = createTelemetryCollector(f.options);
  try {
    const input = { filePath: '/transcripts/session.jsonl', byteOffset: 0, model: 'test-model', parsed: {
      type: 'event_msg', timestamp: '2026-09-24T00:00:00Z', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 },
        total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      } },
    } };
    const result = await collector.captureCodexLine(input);
    assert.equal(result.accepted, true);
    const data = (result.record!.payload as any).data;
    assert.equal(data.usage.input_tokens, 100);
    assert.equal(data.usage.cached_input_tokens, 50);
    assert.equal(data.model, 'test-model');
    assert.equal((await collector.captureCodexLine(input)).accepted, false);
    assert.equal(Object.hasOwn(data, 'costUsd'), false); // No price observation is not a zero cost.
  } finally { collector.close(); f.close(); }
});

test('invalid or secret-bearing identities and noncanonical input cannot create a record', async () => {
  const f = fixture();
  assert.throws(() => createTelemetryCollector({ ...f.options, secretValues: ['run-one'] }), /identity/);
  const collector = createTelemetryCollector(f.options);
  try {
    await assert.rejects(collector.publish({ source: 'agent', kind: 'hook', eventType: 'event', payload: { invalid: Infinity } }));
    assert.equal(collector.events().length, 0);
  } finally { collector.close(); f.close(); }
});

test('a committed telemetry event survives abrupt collector process termination', async () => {
  const { execFileSync } = await import('node:child_process');
  const f = fixture();
  try {
    const module = new URL('../src/index.ts', import.meta.url).href;
    const source = `import {createTelemetryCollector,createSqliteTelemetryStore} from ${JSON.stringify(module)};
      const options=JSON.parse(process.argv[1]);
      const collector=createTelemetryCollector({...options,openStore:()=>createSqliteTelemetryStore(options.database)});
      await collector.publish({source:'agent',kind:'hook',eventType:'run.completed',payload:{retained:true}});
      process.kill(process.pid,'SIGKILL');`;
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, JSON.stringify(f.options)], { stdio: 'pipe' }),
      (error: any) => error.signal === 'SIGKILL');
    const collector = createTelemetryCollector(f.options);
    try { assert.equal(collector.events().length, 1); assert.equal(collector.events()[0]!.eventType, 'run.completed'); }
    finally { collector.close(); }
  } finally { f.close(); }
});

test('offline event reading does not change retained database bytes or create missing artifacts', async () => {
  const { readSqliteTelemetryEvents } = await import('../src/index.js');
  const f = fixture(); const collector = createTelemetryCollector(f.options);
  try {
    await collector.publish({ source: 'agent', kind: 'hook', eventType: 'run.finished', payload: {} });
    collector.close();
    const before = readFileSync(f.options.database);
    assert.equal(readSqliteTelemetryEvents(f.options.database).length, 1);
    assert.deepEqual(readFileSync(f.options.database), before);
    assert.throws(() => readSqliteTelemetryEvents(join(f.root, 'missing.sqlite')));
    assert.ok(!readdirSync(f.root).includes('missing.sqlite'));
  } finally { collector.close(); f.close(); }
});
