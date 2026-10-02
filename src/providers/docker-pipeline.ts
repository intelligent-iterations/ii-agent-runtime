import { mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openTofuWorker, type ProvisionedWorker } from './docker-opentofu.js';
import { isolateWorkerNetwork } from './docker-network.js';
import { openWorkerGateway } from './worker-gateway.js';
import { codexModelGateway } from './codex-model.js';
import { executeCodexWorker } from './codex-worker.js';
import { loadWorkerSource, runWorkerSetup } from './docker-egress.js';
import type { CompiledConfiguration } from '../runtime/configuration.js';
import type { ExecutionTarget, Harness, ModelProvider, Worker } from '../pipeline/ports.js';

export const executionServices = { openTofuWorker, isolateWorkerNetwork, openWorkerGateway, codexModelGateway, executeCodexWorker, loadWorkerSource, runWorkerSetup };
export type ExecutionServices = typeof executionServices;

/**
 * A hardened container on the machine that runs the pipeline (`environment.provider: docker`): OpenTofu creates
 * it without a network; dependency setup briefly joins it to an internet bridge before any credential exists; isolation
 * then joins it to a private bridge that reaches only the worker gateway.
 */
export function dockerTofuTarget(options: { parent: string; executablePath: string; services: ExecutionServices }): ExecutionTarget {
  const owner = randomBytes(16).toString('hex');
  const work = join(options.parent, `agent-runtime-${owner}`);
  let provisioner: ReturnType<typeof openTofuWorker> | undefined;
  return {
    async provision(compiled: CompiledConfiguration): Promise<Worker> {
      mkdirSync(work, { mode: 0o700 });
      writeFileSync(join(work, '.owner'), owner, { flag: 'wx', mode: 0o600 });
      provisioner = options.services.openTofuWorker({ parent: work, executablePath: options.executablePath });
      const worker: ProvisionedWorker = await provisioner.provision(compiled);
      const tools = { executablePath: options.executablePath };
      return {
        handle: worker,
        load: directory => options.services.loadWorkerSource(worker, directory, tools),
        setup: (commands, setup) => options.services.runWorkerSetup(worker, commands, { ...tools, timeoutMs: setup.timeoutMs, signal: setup.signal }),
        isolate: () => options.services.isolateWorkerNetwork(worker, tools),
      };
    },
    async close() {
      try { if (provisioner) await provisioner.close(); }
      finally {
        try { readFileSync(join(work, '.owner')); } catch { return; }
        if (realpathSync(work) !== work || readFileSync(join(work, '.owner'), 'utf8') !== owner ||
          readdirSync(work).some(name => name !== '.owner')) throw Error('Work directory cleanup unconfirmed');
        unlinkSync(join(work, '.owner')); rmdirSync(work);
      }
    },
  };
}

/** Codex CLI inside the worker, reaching the model and the code host only through the gateway (`harness.name: codex`). */
export function codexHarness(compiled: CompiledConfiguration, options: { executablePath: string; services: ExecutionServices }): Harness {
  return {
    execute: (worker, input) => options.services.executeCodexWorker({ worker: worker.handle as ProvisionedWorker, compiled, endpoint: input.endpoint,
      token: input.token, task: input.task, branch: input.branch, delivered: input.delivered, author: input.author, access: input.access,
      timeoutMs: input.timeoutMs, ...(input.base ? { base: input.base } : {}), ...(input.setup ? { setup: input.setup } : {}) },
    { executablePath: options.executablePath, signal: input.signal }),
  };
}

/** OpenAI's Responses API behind the run's request, token and spend limits. The key never reaches the worker. */
export function openaiModel(compiled: CompiledConfiguration, options: { apiKey: () => string; services: ExecutionServices }): ModelProvider {
  const config = compiled.configuration;
  return { open: signal => options.services.codexModelGateway({ model: config.harness.model, apiKey: options.apiKey, limits: config.limits, signal }) };
}
