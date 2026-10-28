import { connectRemoteWorker } from './worker.js';
import type { RemoteSession } from './channel.js';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionTarget } from '../../../pipeline/ports.js';
import type { RuntimeConfiguration } from '../../../runtime/configuration.js';
import { compileDeployment, writeDeployment } from '../../../deployment/compile.js';
import { planDeployment, applyDeployment } from '../../../deployment/operations.js';
import { validateWorkerResources } from '../../../pipeline/worker-resources.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';
import { TargetOperations } from '../shared/operations.js';
import { sshSession, type SshSessionOptions } from './ssh.js';

export type CloudHosting = Extract<NonNullable<RuntimeConfiguration['environment']['hosting']>, { ssh: unknown }>;
export interface CloudTargetOptions {
  hosting: CloudHosting;
  isolation: 'docker' | 'openshell';
  parent: string;
  executablePath: string;
  /** Provider authentication stays on the initiating trusted host, never in the worker or its configuration. */
  environment: Record<string, string>;
  process?: ProcessRunner;
  session?: (options: SshSessionOptions) => RemoteSession;
}

/** Provisions the configured host and exposes its worker through authenticated SSH. */
export function cloudTarget(options: CloudTargetOptions): ExecutionTarget {
  const owner = randomBytes(16).toString('hex');
  const directory = join(options.parent, `host-${owner}`);
  const declaration = { schemaVersion: 1 as const, id: `ii-${owner.slice(0, 24)}`, provider: options.hosting.provider,
    infrastructure: options.hosting.infrastructure, providerConfiguration: options.hosting.providerConfiguration };
  const artifact = compileDeployment(declaration);
  const operations = new TargetOperations(options.process ?? runTrustedProcess, 300000);
  let attempted = false, applied = false, closed = false;
  let remote: RemoteSession | undefined;
  let closePromise: Promise<void> | undefined;
  const operator = (cleanup = false) => ({ directory, environment: { ...options.environment, PATH: options.executablePath },
    process: ((request) => operations.run(request, cleanup)) as ProcessRunner });
  return {
    async provision(input, context) {
      if (attempted || closed) throw Error('Cloud target already used');
      if (!['docker', 'openshell'].includes(options.isolation)) throw Error('Unknown isolation provider');
      attempted = true;
      const resources = validateWorkerResources(input);
      const deadline = Math.min(context?.deadlineMs ?? Infinity, Date.now() + resources.timeoutSeconds * 1000);
      operations.start(resources.timeoutSeconds, context);
      writeDeployment(directory, artifact);
      writeFileSync(join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
      const plan = await planDeployment(operator());
      applied = true; // The provider may create a resource even if its reply is lost.
      const result = await applyDeployment(operator(), plan.planDigest);
      const address = (result.outputs as { address?: { value?: unknown } }).address?.value;
      if (typeof address !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(address)) throw Error('Cloud host address invalid');
      // Wait for cloud-init without trusting a new SSH host key or installing secrets into cloud metadata.
      const remaining = () => Math.max(1, deadline - Date.now());
      // Session startup can fail while the VM boots. Probe only; never replay a provisioning request.
      const ssh = options.hosting.ssh;
      if (!options.session) {
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            await operations.run({ command: 'ssh', args: ['-F', '/dev/null', '-T', '-p', String(ssh.port ?? 22),
              '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
              '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=5', '-o', `UserKnownHostsFile=${ssh.knownHostsFile}`,
              '-i', ssh.identityFile, `${ssh.user}@${address}`, 'sudo -n cloud-init status --wait && sudo -n docker info >/dev/null'],
              cwd: directory, env: { PATH: options.executablePath }, timeoutMs: Math.min(30000, remaining()), maxOutputBytes: 65536 });
            ready = true; break;
          } catch {
            if (context?.signal.aborted || remaining() <= 1) throw Error('Cloud host startup expired');
            await delay(1000, undefined, context ? { signal: context.signal } : {});
          }
        }
        if (!ready) throw Error('Cloud host did not become ready');
      }
      remote = (options.session ?? sshSession)({ address, ...ssh, directory, executablePath: options.executablePath,
        executorImage: options.hosting.executorImage, isolation: options.isolation, owner });
      return connectRemoteWorker({ remote, resources, directory, owner, executablePath: options.executablePath, execute: request => operations.run(request), deadlineMs: deadline, ...(context ? { signal: context.signal } : {}) });
    },
    close() {
      if (closed) return Promise.resolve();
      return closePromise ??= (async () => {
        await operations.cancel();
        let remoteFailed = false;
        if (remote) {
          try { await remote.request('close', {}, 60000); } catch { remoteFailed = true; }
          finally { await remote.close().catch(() => { remoteFailed = true; }); }
        }
        if (applied) {
          if (readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw Error('Cloud deployment ownership changed');
          const plan = await planDeployment(operator(true), 'destroy');
          await applyDeployment(operator(true), plan.planDigest);
        }
        // Keep IaC state and receipts as deployment history, including failed cleanup for explicit recovery.
        if (attempted) writeFileSync(join(directory, 'cleanup.json'), JSON.stringify({ hostDestroyed: applied, remoteCleanupConfirmed: !remoteFailed }), { mode: 0o600 });
        closed = true;
        if (remoteFailed) throw Error('Remote worker cleanup unconfirmed; host destruction confirmed');
      })();
    },
  };
}
