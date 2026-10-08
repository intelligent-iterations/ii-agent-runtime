import { dockerWorkerCommand } from './command.js';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { openTofuWorker, ProvisionedWorker } from './provisioning.js';
import type { ExecutionTarget, Worker, WorkerResources } from '../../../pipeline/ports.js';

import type { ExecutionServices } from '../../services.js';

/**
 * A hardened container on the machine that runs the pipeline (`environment.provider: docker`): OpenTofu creates
 * it without a network; dependency setup briefly joins it to an internet bridge before any credential exists; isolation
 * then joins it to a private bridge that reaches only the worker gateway.
 */
export function dockerTofuTarget(options: { parent: string; executablePath: string; services: Pick<ExecutionServices, 'openTofuWorker' | 'isolateWorkerNetwork' | 'loadWorkerSource' | 'runWorkerSetup'> }): ExecutionTarget {
  const owner = randomBytes(16).toString('hex');
  const work = join(options.parent, `agent-runtime-${owner}`);
  let provisioner: ReturnType<typeof openTofuWorker> | undefined;
  return {
    async provision(resources: WorkerResources): Promise<Worker> {
      mkdirSync(work, { mode: 0o700 });
      writeFileSync(join(work, '.owner'), owner, { flag: 'wx', mode: 0o600 });
      provisioner = options.services.openTofuWorker({ parent: work, executablePath: options.executablePath });
      const worker: ProvisionedWorker = await provisioner.provision(resources);
      const tools = { executablePath: options.executablePath };
      return {
        workspace: '/workspace',
        run: dockerWorkerCommand(worker, tools),
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
