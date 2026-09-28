import type { EvalEventInput, EvalEventRecord } from "../ingest/types.js";

export interface PipelineContext {
  receivedAt: string;
  route: string;
}

export interface PipelineEnvelope {
  event: EvalEventInput;
  context: PipelineContext;
}

export interface PipelineResult {
  accepted: boolean;
  record: EvalEventRecord | null;
  sinkResults: SinkResult[];
}

export interface EventMiddleware {
  readonly name: string;
  handle(envelope: PipelineEnvelope): Promise<PipelineEnvelope | null>;
}

export interface EventSink {
  readonly name: string;
  publish(record: EvalEventRecord, envelope: PipelineEnvelope): Promise<SinkResult>;
}

export interface SinkResult {
  sink: string;
  ok: boolean;
  error?: string;
}
