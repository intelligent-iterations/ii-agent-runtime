export type AgentTelemetrySource = "claude-code" | "codex" | "harness" | "agent" | "unknown";

export type AgentTelemetryKind =
  | "otel.logs"
  | "otel.metrics"
  | "otel.traces"
  | "hook"
  | "transcript"
  | "self_evaluation"
  | "self_evaluation.created"
  | "harness";

export interface EvalEventInput {
  source: AgentTelemetrySource;
  kind: AgentTelemetryKind;
  eventType: string;
  sessionId?: string | null;
  turnId?: string | null;
  timestamp?: string | null;
  payload: unknown;
  dedupKey?: string | null;
}

export interface EvalEventRecord extends Required<Omit<EvalEventInput, "sessionId" | "turnId" | "timestamp" | "dedupKey">> {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  timestamp: string;
  payloadJson: string;
  redactionVersion: string;
  schemaVersion: string;
  dedupKey: string | null;
  createdAt: string;
}

export interface IngesterCursor {
  name: string;
  position: unknown;
}

export interface Ingester {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  cursor(): Promise<IngesterCursor>;
}
