import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { validateWorkerResources } from '../../../pipeline/worker-resources.js';
import type { ExecutionTarget, WorkerCommandRunner } from '../../../pipeline/ports.js';
import { runTrustedProcess, ProcessFailure, type ProcessRunner } from '../../shared/process.js';
import { openSetupProxy } from './setup-proxy.js';
import { SETUP_BASELINE, SETUP_EXECUTE, SETUP_KILL } from './setup.js';
import { TargetOperations } from '../shared/operations.js';
import { openshellPolicy, openshellSetupPolicy, type OpenShellPolicy, verifyOpenShellPolicy, OPENSHELL_VERSION, OPENSHELL_WORKSPACE } from './policy.js';

export interface OpenShellHost {
  /** Infrastructure address on which this process can listen and the sandbox supervisor can reach it. */
  gatewayAddress?: string;
  /** Existing CLI registration and client certificates. Never copied into the worker. */
  configDirectory?: string;
}

function gatewayAddress(configured?: string): string {
  const addresses = configured ? [configured] : [...new Set(Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)))];
  if (addresses.length !== 1 || !isIPv4(addresses[0]!) || /^(127|169\.254|0)\./.test(addresses[0]!)) {
    throw Error('OpenShell needs one reachable host IPv4 address; set host.openshell.gatewayAddress when the host has multiple interfaces');
  }
  return addresses[0]!;
}

/** Experimental pinned CLI adapter. OpenShell owns the box; our gateway retains every workload credential. */
export function openshellTarget(options: { parent: string; executablePath: string; host?: OpenShellHost; process?: ProcessRunner;
  wait?: (milliseconds: number) => Promise<void> }): ExecutionTarget {
  const operations = new TargetOperations(options.process ?? runTrustedProcess);
  const execute: ProcessRunner = request => operations.run(request);
  const owner = randomBytes(16).toString('hex');
  const name = `ii-${owner.slice(0, 16)}`; // v0.1.2 sandbox names have a 19-character limit.
  const parent = resolve(options.parent);
  const directory = join(parent, `agent-runtime-${owner}`);
  const env = { PATH: options.executablePath, HOME: directory,
    XDG_CONFIG_HOME: options.host?.configDirectory ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    OPENSHELL_TELEMETRY_ENABLED: 'false', OPENSHELL_COLOR: 'never' };
  let attempted = false, created = false, closed = false, connected = false;
  let ready = false, busy = false, closing = false, failed = false, isolated = false, policyDirty = false;
  let running = 0, setupUsed = false;
  let closePromise: Promise<void> | undefined;
  let transition: Promise<unknown> | undefined;
  let sealPromise: Promise<void> | undefined;
  const usable = () => {
    if (!ready || closing || closed || failed || busy) throw Error('OpenShell worker is not available in this lifecycle state');
  };
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    usable(); if (running) throw Error('OpenShell commands are still running'); busy = true;
    try { const operation = action(); transition = operation; return await operation; } catch (error) { failed = true; throw error; } finally { busy = false; transition = undefined; }
  };
  const ownership = () => {
    if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw Error('OpenShell work directory ownership changed');
  };
  const cli = (args: string[], timeoutMs = 60000, cleanup = false) => operations.run({ command: 'openshell', args, cwd: directory, env, timeoutMs, maxOutputBytes: 1048576 }, cleanup);
  const rawRun = (request: Parameters<WorkerCommandRunner>[0], cleanup = false) => {
    ownership();
    return operations.run({ ...request, command: 'openshell',
      args: ['sandbox', 'exec', '-n', name, '--no-tty', '--no-login-shell', '--timeout', String(Math.ceil(request.timeoutMs / 1000)),
        '--', request.command, ...request.args], cwd: directory, env }, cleanup);
  };
  const run: WorkerCommandRunner = async request => { usable(); running++; try { return await rawRun(request); } finally { running--; } };
  const settings = async (cleanup = false) => JSON.parse(await cli(['settings', 'get', name, '--json'], 60000, cleanup));
  const checkPolicy = async (policy: OpenShellPolicy, cleanup = false) => {
    verifyOpenShellPolicy(await cli(['sandbox', 'get', name, '--policy-only'], 60000, cleanup), policy);
    const effective = await settings(cleanup);
    if (effective.sandbox !== name || effective.settings?.agent_policy_proposals_enabled?.value !== 'false') {
      throw Error('OpenShell policy advisor must be disabled');
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = JSON.parse(await cli(['sandbox', 'get', name, '--output', 'json'], 60000, cleanup));
      if (state.name !== name || state.phase !== 'Ready' || state.configuration_admission?.state !== 'accepted') throw Error('OpenShell policy is not confirmed active');
      const admitted = state.configuration_admission.policy_version;
      const active = state.current_policy_version;
      if (!Number.isSafeInteger(admitted) || admitted < 1 || !Number.isSafeInteger(active) || active < 0) {
        throw Error('OpenShell policy activation versions are invalid');
      }
      if (active === admitted) return;
      await (options.wait ?? delay)(500);
    }
    throw Error('OpenShell policy activation timed out');
  };
  return {
    async provision(resources, context) {
      if (attempted || closing || closed) throw Error('OpenShell provisioning session already used');
      attempted = true;
      const checked = validateWorkerResources(resources);
      operations.start(checked.timeoutSeconds, context);
      const address = gatewayAddress(options.host?.gatewayAddress);
      if (realpathSync(parent) !== parent || statSync(parent).uid !== process.getuid?.()) throw Error('Unsafe OpenShell provisioning parent');
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, '.owner'), owner, { mode: 0o600, flag: 'wx' });
      let version: string;
      try { version = (await cli(['--version'])).trim(); }
      catch (error) {
        if (error instanceof ProcessFailure && (error.kind === 'canceled' || error.kind === 'deadline')) throw error;
        throw Error(`OpenShell ${OPENSHELL_VERSION} CLI is unavailable`);
      }
      if (version !== `openshell ${OPENSHELL_VERSION}`) throw Error(`OpenShell version mismatch: requires ${OPENSHELL_VERSION}`);
      const status = JSON.parse(await cli(['status', '--output', 'json']));
      if (status.status !== 'connected' || status.version !== OPENSHELL_VERSION) throw Error(`OpenShell gateway version mismatch: requires ${OPENSHELL_VERSION}`);
      const sealed = openshellPolicy();
      const policyPath = join(directory, 'policy.yaml');
      writeFileSync(policyPath, stringify(sealed), { mode: 0o600 });
      // No automatic providers, inferred agent command, or auto-approved policy requests.
      created = true; // Creation can succeed remotely even when the CLI's reply is lost.
      await cli(['sandbox', 'create', '--name', name, '--from', checked.image,
        '--cpu', String(checked.cpu), '--memory', `${checked.memoryMiB}Mi`,
        '--policy', policyPath, '--no-auto-providers', '--approval-mode', 'manual', '--detach', '--output', 'json',
        '--label', `agent-runtime.owner=${owner}`, '--', '/bin/sleep', String(checked.timeoutSeconds)], 300000);
      const advisor = (await settings()).settings?.agent_policy_proposals_enabled;
      if (advisor?.scope === 'global') {
        if (advisor.value !== 'false') throw Error('OpenShell global policy advisor must be disabled');
      } else await cli(['settings', 'set', name, '--key', 'agent_policy_proposals_enabled', '--value', 'false']);
      await checkPolicy(sealed);
      ready = true;
      return {
        workspace: OPENSHELL_WORKSPACE, run,
        load: source => exclusive(async () => {
          if (isolated) throw Error('OpenShell source loading is closed after isolation');
          ownership();
          const archive = join(directory, 'source.tar');
          try {
            await execute({ command: 'tar', args: ['-C', source, '-cf', archive, '.'], cwd: directory, env,
              timeoutMs: 120000, maxOutputBytes: 65536 });
            if (statSync(archive).size > 512 * 1048576) throw Error('Repository too large to load');
            await cli(['sandbox', 'upload', name, archive, `${OPENSHELL_WORKSPACE}/source.tar`, '--no-git-ignore'], 120000);
            await rawRun({ command: 'mkdir', args: ['-p', `${OPENSHELL_WORKSPACE}/repository`, `${OPENSHELL_WORKSPACE}/user`], timeoutMs: 20000, maxOutputBytes: 65536 });
            await rawRun({ command: 'tar', args: ['-xf', `${OPENSHELL_WORKSPACE}/source.tar`, '--no-same-owner', '-C', `${OPENSHELL_WORKSPACE}/repository`], timeoutMs: 120000, maxOutputBytes: 65536 });
            await rawRun({ command: 'rm', args: ['--', `${OPENSHELL_WORKSPACE}/source.tar`], timeoutMs: 20000, maxOutputBytes: 65536 });
          } finally { rmSync(archive, { force: true }); }
        }),
        setup: (commands, setup) => exclusive(async () => {
          if (isolated || setupUsed) throw Error('OpenShell setup phase already closed');
          if (!commands.length || commands.length > 100 || commands.some(command => !command || command.length > 65536 || /[\0\r\n]/.test(command))) throw Error('Invalid setup commands');
          if (!Number.isSafeInteger(setup.timeoutMs) || setup.timeoutMs < 1) throw Error('Invalid setup timeout');
          setupUsed = true;
          const started = Date.now();
          const baseline = await rawRun({ command: 'node', args: ['-e', SETUP_BASELINE], timeoutMs: 10000, maxOutputBytes: 65536, signal: setup.signal });
          const proxy = await openSetupProxy(address, setup.signal);
          let result: { exitCode: number; seconds: number; timedOut: boolean } | undefined;
          let cleanup = false;
          try {
            const policy = openshellSetupPolicy(address, proxy.port);
            policyDirty = true;
            writeFileSync(policyPath, stringify(policy), { mode: 0o600 });
            await cli(['policy', 'set', name, '--policy', policyPath, '--wait']);
            await checkPolicy(policy);
            try {
              const output = JSON.parse(await rawRun({ command: 'node', args: ['-e', SETUP_EXECUTE], input: JSON.stringify({ commands, proxy: proxy.url }),
                timeoutMs: setup.timeoutMs, maxOutputBytes: 65536, signal: setup.signal }));
              if (!Number.isSafeInteger(output.exitCode) || output.exitCode < -1 || output.exitCode > 255 || typeof output.outputLimit !== 'boolean') throw Error('Invalid setup result');
              if (output.outputLimit) throw new ProcessFailure('output-limit', 'Setup log exceeded its output limit');
              result = { exitCode: output.exitCode, seconds: Math.round((Date.now() - started) / 1000), timedOut: false };
            } catch (error) {
              if (!(error instanceof ProcessFailure) || error.kind !== 'deadline') throw error;
              result = { exitCode: -1, seconds: Math.round((Date.now() - started) / 1000), timedOut: true };
            }
          } catch (error) { cleanup = true; throw error; }
          finally {
            proxy.close();
            // A failed or canceled Run gets an independent, bounded cleanup allowance.
            cleanup ||= setup.signal.aborted || !!context?.signal.aborted || Date.now() >= (context?.deadlineMs ?? Infinity);
            const stopped = await rawRun({ command: 'node', args: ['-e', SETUP_KILL], input: baseline, timeoutMs: 10000, maxOutputBytes: 65536 }, cleanup);
            if (stopped !== 'sealed') throw Error('OpenShell setup process cleanup unconfirmed');
            writeFileSync(policyPath, stringify(sealed), { mode: 0o600 });
            await cli(['policy', 'set', name, '--policy', policyPath, '--wait'], 60000, cleanup);
            await checkPolicy(sealed, cleanup);
            policyDirty = false;
          }
          return result!;
        }),
        isolate: () => exclusive(async () => {
          if (isolated) throw Error('OpenShell worker already isolated');
          await checkPolicy(sealed);
          isolated = true;
          return { address,
            connect: port => exclusive(async () => {
              if (connected) throw Error('OpenShell gateway already connected');
              const policy = openshellPolicy(address, port);
              policyDirty = true;
              writeFileSync(policyPath, stringify(policy), { mode: 0o600 });
              await cli(['policy', 'set', name, '--policy', policyPath, '--wait']);
              await checkPolicy(policy);
              connected = true;
            }),
            async close() {
              if (closing) { await closePromise; return; }
              if (sealPromise) return sealPromise;
              if (closed) return;
              ready = false;
              sealPromise = (async () => {
                await operations.cancel();
                await transition?.catch(() => {});
                if (!policyDirty) return;
                writeFileSync(policyPath, stringify(sealed), { mode: 0o600 });
                await cli(['policy', 'set', name, '--policy', policyPath, '--wait'], 60000, true);
                await checkPolicy(sealed, true);
                connected = false; policyDirty = false;
              })();
              return sealPromise;
            },
          };
        }),
      };
    },
    close() {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await operations.cancel();
        await transition?.catch(() => {});
        await sealPromise?.catch(() => {});
        if (created) {
          ownership();
          const present = async () => {
            const list = JSON.parse(await cli(['sandbox', 'list', '--output', 'json', '--selector', `agent-runtime.owner=${owner}`], 60000, true));
            if (!Array.isArray(list.sandboxes) || list.next_page_token || list.sandboxes.length > 1 ||
              list.sandboxes.some((sandbox: { name?: unknown }) => sandbox?.name !== name)) throw Error('OpenShell cleanup response is incomplete or ownership differs');
            return list.sandboxes.length !== 0;
          };
          if (await present()) {
            // A reply can be lost after the provider deletes the sandbox. Only absence proves cleanup.
            try { await cli(['sandbox', 'delete', name], 60000, true); } catch { /* Read back below; never assume success. */ }
            let gone = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              if (!await present()) { gone = true; break; }
              await (options.wait ?? delay)(1000);
            }
            if (!gone) throw Error('OpenShell sandbox cleanup unconfirmed');
          }
        }
        if (attempted) {
          try { ownership(); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !created) { closed = true; return; }
            throw error;
          }
          rmSync(directory, { recursive: true });
        }
        closed = true;
      })();
      void closePromise.catch(() => { closePromise = undefined; });
      return closePromise;
    },
  };
}
