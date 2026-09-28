// Adapted: missing context window is JSON null, not undefined.
import fs from "node:fs";
import path from "node:path";

import type { EventPipeline } from "../pipeline/eventPipeline.js";
import type { EvalEventInput, Ingester, IngesterCursor } from "./types.js";

export interface CodexWatcherOptions {
  transcriptDir: string;
  cursorsDir: string;
  pipeline: EventPipeline;
}

interface FileCursor {
  path: string;
  inode: number;
  byteOffset: number;
  mtimeMs: number;
}

export class CodexTranscriptWatcher implements Ingester {
  readonly name = "codex-transcript-watcher";
  private watcher: fs.FSWatcher | null = null;
  private stats = { filesSeen: 0, eventsIngested: 0, parseErrors: 0 };

  constructor(private readonly options: CodexWatcherOptions) {}

  async start(): Promise<void> {
    fs.mkdirSync(this.options.cursorsDir, { recursive: true, mode: 0o700 });
    await this.scanOnce();
    this.watcher = fs.watch(this.options.transcriptDir, { recursive: true }, () => {
      void this.scanOnce();
    });
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
  }

  async cursor(): Promise<IngesterCursor> {
    return { name: this.name, position: this.stats };
  }

  async scanOnce(): Promise<void> {
    for (const filePath of listFiles(this.options.transcriptDir)) {
      if (!/\.(jsonl|json|txt|md)$/i.test(filePath)) {
        continue;
      }
      await this.ingestFile(filePath);
    }
  }

  private async ingestFile(filePath: string): Promise<void> {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return;
    }
    this.stats.filesSeen += 1;
    const cursor = this.readCursor(filePath, stat.ino);
    const start = cursor && cursor.inode === stat.ino && cursor.byteOffset <= stat.size ? cursor.byteOffset : 0;
    if (start >= stat.size) {
      return;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let offset = start;
      let currentModel: string | null = null;
      for (const entry of splitLines(buffer)) {
        const line = entry.text;
        if (!line.trim()) {
          offset = start + entry.nextOffset;
          continue;
        }
        try {
          const parsed = parseTranscriptLine(line);
          currentModel = codexModelFromLine(parsed) ?? currentModel;
          const event = normalizeCodexTranscriptEvent({ filePath, byteOffset: offset, parsed, model: currentModel });
          const record = await this.options.pipeline.publish(event, "codex-transcript");
          if (record.accepted) {
            this.stats.eventsIngested += 1;
          }
        } catch {
          this.stats.parseErrors += 1;
        }
        offset = start + entry.nextOffset;
      }
      this.writeCursor({ path: filePath, inode: stat.ino, byteOffset: stat.size, mtimeMs: stat.mtimeMs });
    } finally {
      fs.closeSync(fd);
    }
  }

  private cursorPath(filePath: string): string {
    const encoded = Buffer.from(path.resolve(filePath)).toString("base64url");
    return path.join(this.options.cursorsDir, `${encoded}.json`);
  }

  private readCursor(filePath: string, inode: number): FileCursor | null {
    const cursorPath = this.cursorPath(filePath);
    if (!fs.existsSync(cursorPath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8")) as FileCursor;
      return parsed.path === filePath && Number.isInteger(parsed.byteOffset) && Number.isInteger(inode) ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeCursor(cursor: FileCursor): void {
    fs.mkdirSync(this.options.cursorsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.cursorPath(cursor.path), `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
  }
}

function splitLines(buffer: Buffer): Array<{ text: string; offset: number; nextOffset: number }> {
  const output: Array<{ text: string; offset: number; nextOffset: number }> = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    const nextOffset = newline === -1 ? buffer.length : newline + 1;
    let contentEnd = newline === -1 ? buffer.length : newline;
    if (contentEnd > cursor && buffer[contentEnd - 1] === 0x0d) {
      contentEnd -= 1;
    }
    output.push({
      text: buffer.subarray(cursor, contentEnd).toString("utf8"),
      offset: cursor,
      nextOffset
    });
    cursor = nextOffset;
  }
  return output;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const output: string[] = [];
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    const childPath = path.join(root, child.name);
    if (child.isDirectory()) {
      output.push(...listFiles(childPath));
    } else if (child.isFile()) {
      output.push(childPath);
    }
  }
  return output;
}

function parseTranscriptLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return trimmed;
}

export function normalizeCodexTranscriptEvent(input: {
  filePath: string;
  byteOffset: number;
  parsed: unknown;
  model?: string | null;
}): EvalEventInput {
  if (isObject(input.parsed) && input.parsed.type === "event_msg" && isObject(input.parsed.payload) && input.parsed.payload.type === "token_count") {
    const usage = isObject(input.parsed.payload.info) && isObject(input.parsed.payload.info.last_token_usage)
      ? input.parsed.payload.info.last_token_usage
      : {};
    const totalUsage =
      isObject(input.parsed.payload.info) && isObject(input.parsed.payload.info.total_token_usage)
        ? input.parsed.payload.info.total_token_usage
        : {};
    return {
      source: "codex",
      kind: "transcript",
      eventType: "codex.token_count",
      sessionId: sessionIdFromTranscriptPath(input.filePath),
      timestamp: stringOrNull(input.parsed.timestamp),
      payload: {
        transcript_path: input.filePath,
        byte_offset: input.byteOffset,
        usage,
        total_usage: totalUsage,
        model: input.model ?? null,
        model_context_window: isObject(input.parsed.payload.info) ? (input.parsed.payload.info.model_context_window ?? null) : null,
        rate_limits: input.parsed.payload.rate_limits ?? null
      },
      dedupKey: `${input.filePath}:${input.byteOffset}:token_count`
    };
  }

  return {
    source: "codex",
    kind: "transcript",
    eventType: "codex.transcript.line",
    sessionId: sessionIdFromTranscriptPath(input.filePath),
    timestamp: isObject(input.parsed) ? stringOrNull(input.parsed.timestamp) : null,
    payload: { path: input.filePath, line: input.parsed },
    dedupKey: `${input.filePath}:${input.byteOffset}`
  };
}

function codexModelFromLine(parsed: unknown): string | null {
  if (!isObject(parsed)) {
    return null;
  }
  if (parsed.type === "turn_context" && isObject(parsed.payload) && typeof parsed.payload.model === "string") {
    return parsed.payload.model;
  }
  return null;
}

function sessionIdFromTranscriptPath(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
