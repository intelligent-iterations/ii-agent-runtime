import type { EvalEventInput, EvalEventRecord } from './imported/ingest/types.js';
/** Opened explicitly by the consumer; ownership transfers to the collector until close(). */
export interface TelemetryStore {
  recordEvent(event: EvalEventInput): EvalEventRecord | null | Promise<EvalEventRecord | null>;
  listEvents(limit?: number): EvalEventRecord[];
  close(): void;
}
