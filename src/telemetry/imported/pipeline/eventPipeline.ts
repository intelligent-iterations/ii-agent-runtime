// Adapted: sink errors use stable codes and never retain exception text.
import fs from "node:fs";
import path from "node:path";

import type { EvalEventInput } from "../ingest/types.js";
import type { TelemetryStore } from "../../store.js";
import type { EventMiddleware, EventSink, PipelineEnvelope, PipelineResult, SinkResult } from "./types.js";

export interface EventPipelineOptions {
  db: TelemetryStore;
  middleware?: EventMiddleware[];
  sinks?: EventSink[];
  errorLogPath?: string | null;
}

export class EventPipeline {
  private readonly middleware: EventMiddleware[];
  private readonly sinks: EventSink[];

  constructor(private readonly options: EventPipelineOptions) {
    this.middleware = options.middleware ?? [];
    this.sinks = options.sinks ?? [];
  }

  sinkNames(): string[] {
    return this.sinks.map((sink) => sink.name);
  }

  async publish(event: EvalEventInput, route = "internal"): Promise<PipelineResult> {
    let envelope: PipelineEnvelope | null = {
      event,
      context: {
        receivedAt: new Date().toISOString(),
        route
      }
    };

    for (const middleware of this.middleware) {
      envelope = await middleware.handle(envelope);
      if (!envelope) {
        return { accepted: false, record: null, sinkResults: [] };
      }
    }

    let record;
    try { record = await this.options.db.recordEvent(envelope.event); }
    catch { throw new Error('Telemetry storage failed'); }
    if (!record) {
      return { accepted: false, record: null, sinkResults: [] };
    }

    const sinkResults: SinkResult[] = [];
    for (const sink of this.sinks) {
      try {
        const result = await sink.publish(record, envelope);
        sinkResults.push({ sink: sink.name, ok: result.ok, ...(result.ok ? {} : { error: "delivery_failed" }) });
        // A sink that reports failure without throwing (an HTTP 4xx/5xx, most
        // commonly) is still a delivery failure. Logging only thrown errors
        // makes a rejected or unauthorized remote sink indistinguishable from a
        // healthy one.
        if (!result.ok) {
          this.appendError({ type: "sink_failure", sink: sink.name, error: "delivery_failed", eventId: record.id });
        }
      } catch (error) {
        const result = {
          sink: sink.name,
          ok: false,
          error: "delivery_failed"
        };
        sinkResults.push(result);
        this.appendError({ type: "sink_failure", sink: sink.name, error: "delivery_failed", eventId: record.id });
      }
    }

    return { accepted: true, record, sinkResults };
  }

  private appendError(payload: Record<string, unknown>): void {
    if (!this.options.errorLogPath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.options.errorLogPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.options.errorLogPath, `${JSON.stringify({ ...payload, createdAt: new Date().toISOString() })}\n`, {
        mode: 0o600
      });
    } catch {
      // Pipeline errors must not break ingestion.
    }
  }
}
