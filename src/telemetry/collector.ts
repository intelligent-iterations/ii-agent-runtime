import { createHash } from 'node:crypto';
import { canonicalJson, parseSetup, setupDigest } from '../setup.js';
import type { TelemetryStore } from './store.js';
import { EventPipeline } from './imported/pipeline/eventPipeline.js';
import { redactPayload } from './imported/redact.js';
import { normalizeCodexTranscriptEvent } from './imported/ingest/codexWatcher.js';
import type { EvalEventInput } from './imported/ingest/types.js';
import type { EventSink, EventMiddleware, PipelineResult } from './imported/pipeline/types.js';

export interface RunCorrelation {
  executionId: string;
  attemptId: string;
  setupId: string;
  setupRevision: string;
  setupDigest: string;
}
export interface TelemetryOptions {
  openStore(): TelemetryStore;
  setup: unknown;
  executionId: string;
  attemptId: string;
  /** In-memory exact values to exclude. Never stored in records or configuration. */
  secretValues?: readonly string[];
  sinks?: readonly EventSink[];
}
function identity(value: string): boolean { return /^[A-Za-z0-9_.:-]{1,160}$/.test(value); }
function literal(value: string): RegExp { return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); }

/** Imported collector integration; storage is telemetry-only, not an application lifecycle database. */
export function createTelemetryCollector(options: TelemetryOptions) {
  const setup = parseSetup(options.setup);
  if (!identity(options.executionId) || !identity(options.attemptId)) throw Error('Invalid run identity');
  const correlation: RunCorrelation = { executionId: options.executionId, attemptId: options.attemptId,
    setupId: setup.id, setupRevision: setup.revision, setupDigest: setupDigest(setup) };
  const denied = [...(options.secretValues ?? [])];
  if (denied.some(value => !value.length)) throw Error('Empty secret cannot be excluded');
  const sinks = [...(options.sinks ?? [])];
  if (sinks.some(sink => !identity(sink.name)) || new Set(sinks.map(sink => sink.name)).size !== sinks.length) throw Error('Invalid telemetry destination names');
  if (denied.some(secret => canonicalJson(correlation).includes(secret) || sinks.some(sink => sink.name.includes(secret)))) throw Error('Secret value appears in telemetry identity');
  const middleware: EventMiddleware = {
    name: 'run-correlation-and-redaction',
    async handle(envelope) {
      // Canonicalization snapshots caller objects and rejects cycles, nonfinite numbers and unsupported values.
      const value = JSON.parse(canonicalJson(envelope.event)) as EvalEventInput;
      const redacted = redactPayload(value, { denylist: denied.map(literal) });
      if (redacted.dropped) throw Error('Telemetry redaction failed');
      const event = redacted.value;
      if (!identity(event.eventType) || !identity(event.source) || !identity(event.kind)) throw Error('Invalid telemetry event identity');
      const dedupKey = value.dedupKey === undefined || value.dedupKey === null ? null : createHash('sha256')
        .update(canonicalJson([correlation.executionId, correlation.attemptId, event.dedupKey])).digest('hex');
      return { ...envelope, event: { ...event, dedupKey, payload: { data: event.payload, runtime: { ...correlation } } } };
    },
  };
  const db = options.openStore();
  const pipeline = new EventPipeline({ db, middleware: [middleware], sinks });
  let closed = false;
  return {
    correlation: Object.freeze({ ...correlation }),
    publish(event: EvalEventInput): Promise<PipelineResult> {
      if (closed) return Promise.reject(Error('Telemetry collector is closed'));
      return pipeline.publish(event, 'runtime');
    },
    /** Adapt an observed native transcript line; the consumer owns harness execution and file reading. */
    captureCodexLine(input: { filePath: string; byteOffset: number; parsed: unknown; model?: string | null }): Promise<PipelineResult> {
      if (closed) return Promise.reject(Error('Telemetry collector is closed'));
      if (!Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0) throw Error('Invalid transcript position');
      return pipeline.publish(normalizeCodexTranscriptEvent(input), 'runtime');
    },
    events(limit = 100) { if (closed) throw Error('Telemetry collector is closed'); return db.listEvents(limit); },
    close() { if (closed) return; closed = true; denied.fill(''); db.close(); },
  };
}
