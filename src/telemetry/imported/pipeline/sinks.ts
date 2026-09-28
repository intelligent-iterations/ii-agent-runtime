// Adapted: only the local JSONL sink is imported; consumers supply remote destinations.
import fs from "node:fs";
import path from "node:path";

import type { EvalEventRecord } from "../ingest/types.js";
import type { EventSink, PipelineEnvelope, SinkResult } from "./types.js";

export class JsonlSink implements EventSink {
  readonly name = "jsonl";

  constructor(private readonly filePath: string) {}

  async publish(record: EvalEventRecord, envelope: PipelineEnvelope): Promise<SinkResult> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      this.filePath,
      `${JSON.stringify({ recordId: record.id, route: envelope.context.route, event: record })}\n`,
      { mode: 0o600 }
    );
    return { sink: this.name, ok: true };
  }
}
