import type { CompiledConfiguration } from '../../../runtime/configuration.js';
import type { Harness } from '../../../pipeline/ports.js';
import type { ExecutionServices } from '../../services.js';

/** Codex CLI inside the worker, reaching the model and the code host only through the gateway (`harness.name: codex`). */
export function codexHarness(compiled: CompiledConfiguration, options: { executablePath: string; services: Pick<ExecutionServices, 'executeCodexWorker'> }): Harness {
  return {
    execute: (worker, input) => options.services.executeCodexWorker({ worker, compiled, endpoint: input.endpoint,
      token: input.token, task: input.task, branch: input.branch, delivered: input.delivered, author: input.author, access: input.access,
      timeoutMs: input.timeoutMs, ...(input.base ? { base: input.base } : {}), ...(input.setup ? { setup: input.setup } : {}) },
    { signal: input.signal }),
  };
}
