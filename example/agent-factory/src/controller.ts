import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFactory, type FactoryConfig } from './index.js';
import { setupDigest, type CheckContext, type DeploymentManifest, type LibvirtManifest, type GitHubTransport } from '@intelligent-iterations/ii-agent-runtime';
import { createTartExecutor, createLibvirtExecutor } from './tart-executor.js';
import { createGitHubJob, type GitHubJobOptions } from './github-job.js';
import { buildWorkerBundle, createGuestStager } from './guest-stage.js';
import type { InterruptedAttempt, RetainedAttempt } from './guest-retain.js';
import { createGuestRetainer } from './guest-retain.js';
import { startLocalCoordinator, type ExecutionContext } from './local-coordinator.js';
import type { AgentGrantProvider } from './guest-stage.js';

export interface ControllerOptions {
  runner?: { groupId: number; workFolder: string };
  sourceBundle?: import('./guest-stage.js').SourceBundleProvider;
  factory: FactoryConfig;
  stateRoot: string;
  repository: string;
  transport: GitHubTransport;
  checks: CheckContext;
  binaries: DeploymentManifest['binaries'] | LibvirtManifest['binaries'];
  /** Keep old bindings while their attempts may need recovery. Keys are setup digests. */
  workflows: Record<string, { id: number; ref: string; commit: string }>;
  verify: GitHubJobOptions['verify'];
  publish?: GitHubJobOptions['publish'];
  agentGrant?: AgentGrantProvider;
  endAgentGrant?: (context: ExecutionContext) => Promise<void>;
  reportUsage(context: ExecutionContext, retained: RetainedAttempt | InterruptedAttempt): Promise<void>;
  recoverVerification?: NonNullable<GitHubJobOptions['recoverVerification']>;
  coordination?: { maxAgents?: number; pollMs?: number };
}

/** Configure once, then use the returned spawn method for each agent. */
export async function startFactory(options: ControllerOptions) {
  if (typeof options.reportUsage !== 'function') throw Error('A usage delivery callback is required before workloads can start');
  const maxAgents = options.coordination?.maxAgents ?? 2;
  for (const role of Object.values(options.factory.roles)) {
    if (role.authMode !== 'api-key') throw Error('Only Codex API-key roles are supported');
    if (!options.workflows[setupDigest(role.setup)]) throw Error('Every role requires an approved workflow binding');
  }
  const stateRoot = resolve(options.stateRoot);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const deployments = join(stateRoot, 'deployments'); const outputs = join(stateRoot, 'outputs');
  for (const path of [deployments, outputs]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const bundle = buildWorkerBundle();
  const retain = createGuestRetainer(outputs);
  const factory = createFactory(options.factory);
  const workflows = structuredClone(options.workflows);
  const configurations = new Map<string, ReturnType<typeof createTartExecutor>>();
  function executor(context: ExecutionContext) {
    const input = JSON.parse(context.task.input);
    const digest = setupDigest(input.role.setup);
    const workflow = workflows[digest];
    if (!workflow) throw Error('No approved workflow for this setup digest');
    let controller = configurations.get(digest);
    if (!controller) {
      const job = createGitHubJob({ transport: options.transport, repository: options.repository,
        workflowId: workflow.id, ref: workflow.ref, commit: workflow.commit,
        secretName: input.role.credentialKey,
        stage: createGuestStager(bundle, workflow.commit, undefined, options.sourceBundle, options.agentGrant),
        retain: async (context, resource, run) => {
          const evidence = await retain(context, resource, run);
          await options.reportUsage(context, evidence);
          return evidence;
        }, verify: options.verify,
        ...(options.publish ? { publish: options.publish } : {}),
        ...(options.recoverVerification ? { recoverVerification: options.recoverVerification } : {}) });
      const common = { root: deployments, repository: options.repository, transport: options.transport,
        checks: options.checks, ...(options.runner ? { runner: options.runner } : {}),
        ...(options.endAgentGrant ? { onCleanup: options.endAgentGrant } : {}), job };
      if (input.role.setup.deployment.provider === 'tart' && 'tart' in options.binaries) {
        controller = createTartExecutor({ ...common, binaries: options.binaries });
      } else if (input.role.setup.deployment.provider === 'libvirt' && 'virsh' in options.binaries) {
        controller = createLibvirtExecutor({ ...common, binaries: options.binaries });
      } else throw Error('Host tools do not match the requested VM provider');
      configurations.set(digest, controller);
    }
    return controller;
  }
  let service: Awaited<ReturnType<typeof startLocalCoordinator>>;
  try {
    service = await startLocalCoordinator({ database: options.factory.database, project: options.factory.project,
      execute: context => executor(context).execute(context), recover: context => executor(context).recover(context),
      maxConcurrentAgents: maxAgents, ...(options.coordination?.pollMs === undefined ? {} : { pollMs: options.coordination.pollMs }) });
  } catch (error) { factory.close(); throw error; }
  let closed: Promise<void> | undefined;
  return {
    spawn: factory.spawn, agent: factory.agent, list: factory.list, permissions: factory.permissions,
    coordinatorFailed: service.failure,
    close(): Promise<void> {
      closed ??= (async () => { await service.close(); factory.close(); })();
      return closed;
    },
  };
}
