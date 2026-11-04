import { dockerDaemonIdentity, dockerImplementationDigest, privateDirectory, retainOwnedJson, type DockerTargetCheckpoint, type DockerTargetReference } from './retained.js';
import { canonicalJson, digest } from '../../../runtime/configuration.js';
import { validateWorkerResources } from '../../../pipeline/worker-resources.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';
import { dockerWorkerCommand, dockerWorkerSession } from './command.js';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { openTofuWorker, ProvisionedWorker } from './provisioning.js';
import type { ExecutionContext, ExecutionTarget, Worker, WorkerResources } from '../../../pipeline/ports.js';

import type { ExecutionServices } from '../../services.js';

/**
 * A hardened container on the execution host where this adapter is explicitly instantiated: OpenTofu creates
 * it without a network; dependency setup briefly joins it to an internet bridge before any credential exists; isolation
 * then joins it to a private bridge that reaches only the worker gateway.
 */
export function dockerTofuTarget(options: { parent: string; checkpoint?: (value: DockerTargetCheckpoint) => Promise<void>; process?: ProcessRunner; workspaceHelperImage?: string; namespacePolicyImage?: string; executablePath: string; services: Pick<ExecutionServices, 'openTofuWorker' | 'isolateWorkerNetwork' | 'loadWorkerSource' | 'runWorkerSetup'> }): ExecutionTarget {
  const owner = randomBytes(16).toString('hex');
  const work = join(options.parent, `agent-runtime-${owner}`);
  let attempted = false, created = false, closed = false;
  let reference: DockerTargetReference | undefined;
  let provisioner: ReturnType<typeof openTofuWorker> | undefined;
  return {
    async provision(resources: WorkerResources, context?: ExecutionContext): Promise<Worker> {
      if (attempted || closed) throw Error('Target session already used');
      attempted = true;
      const checked = validateWorkerResources(resources);
      const localDeadline = Date.now() + checked.timeoutSeconds * 1000;
      const effectiveContext = context && context.deadlineMs <= localDeadline ? context : {
        deadlineMs: localDeadline, signal: context?.signal ?? new AbortController().signal };
      const active = () => { if (effectiveContext.signal.aborted || Date.now() >= effectiveContext.deadlineMs) throw Error('Docker target interrupted'); };
      if (options.checkpoint) {
        privateDirectory(options.parent);
        const daemonId = await dockerDaemonIdentity(options.process ?? runTrustedProcess, { directory: options.parent,
          executablePath: options.executablePath, signal: effectiveContext.signal, timeoutMs: effectiveContext.deadlineMs - Date.now() });
        reference = { schemaVersion: 1, backend: 'docker-tofu', owner, daemonId, implementationDigest: dockerImplementationDigest(), resources: checked,
          namespacePolicyImage: options.namespacePolicyImage ?? null, workspaceHelperImage: options.workspaceHelperImage ?? null };
        await options.checkpoint({ phase: 'preparing', reference });
        active();
      }
      mkdirSync(work, { mode: 0o700 });
      created = true;
      writeFileSync(join(work, '.owner'), owner, { flag: 'wx', mode: 0o600 });
      provisioner = options.services.openTofuWorker({ parent: work, owner, ...(options.process ? { process: options.process } : {}), executablePath: options.executablePath, ...(options.workspaceHelperImage ? { workspaceHelperImage: options.workspaceHelperImage } : {}), ...(options.namespacePolicyImage ? { namespacePolicyImage: options.namespacePolicyImage } : {}) });
      if (reference) { await options.checkpoint!({ phase: 'provisioning', reference }); active(); }
      const worker: ProvisionedWorker = await provisioner.provision(checked, effectiveContext);
      const tools = { executablePath: options.executablePath };
      return {
        workspace: '/workspace',
        run: dockerWorkerCommand(worker, tools),
        open: dockerWorkerSession(worker, tools),
        load: directory => options.services.loadWorkerSource(worker, directory, tools),
        setup: (commands, setup) => options.services.runWorkerSetup(worker, commands, { ...tools, timeoutMs: setup.timeoutMs, signal: setup.signal }),
        isolate: () => options.services.isolateWorkerNetwork(worker, tools),
      };
    },
    async close() {
      // A failed provider cleanup is never evidence of a cleaned Run, even when
      // the provider removed its state directory before reporting the failure.
      if (closed) return;
      if (provisioner) await provisioner.close();
      if (!created) {
        if (reference) await options.checkpoint!({ phase: 'cleaned', reference });
        closed = true; return;
      }
      privateDirectory(work, owner);
      if (reference) {
        retainOwnedJson(work, '.cleanup-proof.json', { schemaVersion: 1, owner, referenceDigest: digest(canonicalJson(reference)) });
        await options.checkpoint!({ phase: 'cleaned', reference });
      }
      if (realpathSync(work) !== work || readFileSync(join(work, '.owner'), 'utf8') !== owner ||
        readdirSync(work).some(name => name !== '.owner' && !(reference && name === '.cleanup-proof.json'))) throw Error('Work directory cleanup unconfirmed');
      if (reference) unlinkSync(join(work, '.cleanup-proof.json'));
      unlinkSync(join(work, '.owner')); rmdirSync(work);
      closed = true;
    },
  };
}
