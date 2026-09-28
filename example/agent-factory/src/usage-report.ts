import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, readSqliteTelemetryEvents, setupDigest } from '@intelligent-iterations/ii-agent-runtime';
import type { ExecutionContext } from './local-coordinator.js';
import type { InterruptedAttempt, RetainedAttempt } from './guest-retain.js';

export interface UsageBilling {
  mode: 'metered_api' | 'metered_credits' | 'cloud_provider' | 'unknown';
  provider: string; plan?: string;
}
export interface UsageReport {
  schemaVersion: 1; eventId: string; executionId: string; attemptId: string; setupDigest: string;
  workloadDigest: string | null;
  destinationId: string; billing: UsageBilling; model: string | null; modelSource: 'configured' | 'unknown';
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  evidence: 'complete' | 'partial' | 'missing'; observedTurns: number;
  tokens: { input: number; cachedInput: number | null; output: number; total: number } | null;
  /** No token-price assumption is made by this adapter. */
  apiEquivalentCostUsd: null; actualCostUsd: number | null;
}
export interface UsageReporterOptions {
  destinationId: string;
  billing: UsageBilling;
  /** Consumer supplies its authenticated destination; credentials never enter the report. */
  deliver(report: UsageReport): Promise<{ eventId: string; receiptId: string }>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** Factory delivery policy over runtime-collected evidence. The destination must deduplicate eventId. */
export function createUsageReporter(options: UsageReporterOptions) {
  const destinationId = options.destinationId;
  const billing: UsageBilling = { mode: options.billing.mode, provider: options.billing.provider, ...(options.billing.plan === undefined ? {} : { plan: options.billing.plan }) };
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(destinationId) || !['metered_api', 'metered_credits', 'cloud_provider', 'unknown'].includes(billing.mode) ||
      !/^[A-Za-z0-9_.:-]{1,100}$/.test(billing.provider) || (billing.plan !== undefined && !/^[A-Za-z0-9_.:-]{1,100}$/.test(billing.plan))) throw Error('Invalid usage destination or billing');
  return async (context: ExecutionContext, retained: RetainedAttempt | InterruptedAttempt): Promise<void> => {
    for (const file of retained.files) {
      const value = readFileSync(file.localPath);
      if (value.length !== file.size || hash(value) !== file.sha256) throw Error('Usage evidence changed');
    }
    let report = context.record('usage:report') as UsageReport | null;
    if (!report) {
      const input = JSON.parse(context.task.input);
      const digest = setupDigest(input.role.setup);
      const telemetry = retained.files.find(file => file.path === 'telemetry.sqlite');
      const journal = retained.files.some(file => file.path === 'telemetry.sqlite-wal');
      let observedTurns = 0; let inputTokens = 0; let outputTokens = 0; let cachedInput: number | null = 0; let invalid = false;
      // Partial journals require reconstruction before their counts can be claimed.
      if (telemetry && !journal) {
        const events = readSqliteTelemetryEvents(telemetry.localPath, 100_000);
        if (events.length === 100_000) throw Error('Usage event inventory exceeds limit');
        for (const event of events) {
          const payload = event.payload as { runtime?: { executionId: string; attemptId: string; setupDigest: string }; data?: { type?: string; usage?: Record<string, unknown> } };
          if (payload.runtime?.executionId !== context.task.id || payload.runtime.attemptId !== context.attemptId || payload.runtime.setupDigest !== digest) throw Error('Usage evidence correlation mismatch');
          if (event.source !== 'codex' || event.eventType !== 'codex.exec.event' || payload.data?.type !== 'turn.completed') continue;
          const usage = payload.data.usage;
          if (!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens) ||
              (usage.cached_input_tokens !== undefined && (!integer(usage.cached_input_tokens) || usage.cached_input_tokens > usage.input_tokens))) { invalid = true; continue; }
          observedTurns++; inputTokens += usage.input_tokens; outputTokens += usage.output_tokens;
          cachedInput = cachedInput !== null && integer(usage.cached_input_tokens) ? cachedInput + usage.cached_input_tokens : null;
          if (![inputTokens, outputTokens, inputTokens + outputTokens].every(Number.isSafeInteger)) throw Error('Usage count exceeds exact integer range');
        }
      }
      const interrupted = 'interrupted' in retained;
      const complete = !interrupted && retained.worker.telemetryComplete && retained.worker.observedUsage && observedTurns > 0 && !invalid && !journal;
      report = { schemaVersion: 1, eventId: hash(canonicalJson(['usage-v1', context.task.id, context.attemptId])), executionId: context.task.id,
        attemptId: context.attemptId, setupDigest: digest, destinationId, billing,
        workloadDigest: (context.record('workerStaging') as { workloadDigest?: string } | null)?.workloadDigest ?? null,
        model: typeof input.role.model === 'string' ? input.role.model : null, modelSource: typeof input.role.model === 'string' ? 'configured' : 'unknown',
        outcome: interrupted ? 'interrupted' : retained.worker.state, evidence: complete ? 'complete' : observedTurns ? 'partial' : 'missing', observedTurns,
        tokens: observedTurns ? { input: inputTokens, cachedInput, output: outputTokens, total: inputTokens + outputTokens } : null,
        apiEquivalentCostUsd: null, actualCostUsd: null };
      context.checkpoint('usage:report', report);
    }
    if (report.destinationId !== destinationId || canonicalJson(report.billing) !== canonicalJson(billing)) throw Error('Usage configuration changed; use the original destination and billing');
    const previous = context.record('usage:receipt') as { eventId: string; receiptId: string } | null;
    if (previous) {
      if (previous.eventId !== report.eventId) throw Error('Usage receipt identity mismatch');
      return;
    }
    let receipt: { eventId: string; receiptId: string };
    // Persisted checkpoints use canonical JSON. Use the same ordering on the
    // first delivery so an acknowledgement loss also replays identical bytes.
    try { receipt = await options.deliver(JSON.parse(canonicalJson(report))); }
    catch { throw Error('Usage delivery unconfirmed; retry the retained report'); }
    if (!receipt || receipt.eventId !== report.eventId || typeof receipt.receiptId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(receipt.receiptId)) throw Error('Usage acknowledgement mismatch');
    context.checkpoint('usage:receipt', { eventId: receipt.eventId, receiptId: receipt.receiptId });
  };
}
