import type { ExecutionContext } from '../../../pipeline/ports.js';
import { ProcessFailure, type ProcessRequest, type ProcessRunner } from '../../shared/process.js';

/** One Run's subprocess budget, with a separate bounded cleanup allowance. */
export class TargetOperations {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<string>>();
  private cleanupDeadline: number | undefined;
  private context: ExecutionContext | undefined;
  private deadline = 0;

  constructor(private readonly process: ProcessRunner) {}

  start(timeoutSeconds: number, context?: ExecutionContext): void {
    if (this.deadline || this.stop.signal.aborted) throw Error('Target operation scope already used');
    const deadline = Math.min(Date.now() + timeoutSeconds * 1000, context?.deadlineMs ?? Infinity);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new ProcessFailure('deadline', 'Run deadline expired');
    this.deadline = deadline;
    this.context = context;
  }

  async run(request: ProcessRequest, cleanup = false): Promise<string> {
    if (!this.deadline) throw Error('Target operation scope has not started');
    const deadline = cleanup ? this.beginCleanup() : this.deadline;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProcessFailure('deadline', cleanup ? 'Cleanup deadline expired' : 'Run deadline expired');
    if (!cleanup && (this.stop.signal.aborted || this.context?.signal.aborted || request.signal?.aborted)) {
      throw new ProcessFailure('canceled', 'Target operation canceled');
    }
    const { signal: requestedSignal, ...rest } = request;
    const signals = cleanup ? [] : [this.stop.signal, this.context?.signal, requestedSignal].filter((signal): signal is AbortSignal => !!signal);
    const operation = this.process({ ...rest, timeoutMs: Math.min(request.timeoutMs, remaining),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
    this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }

  beginCleanup(): number {
    // One fixed allowance for all cleanup calls, not a fresh timeout for each poll.
    return this.cleanupDeadline ??= Date.now() + 60000;
  }

  async cancel(): Promise<void> {
    this.beginCleanup();
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
}
