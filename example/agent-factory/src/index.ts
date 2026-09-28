import { parseSetup, type Setup } from '@intelligent-iterations/ii-agent-runtime';
import { describeRolePermissions, type RolePermissions } from './permissions.js';
import { authCredentialReference } from './role-credentials.js';
import { WorkStore, type TaskRecord } from './store.js';

export interface Role { kind: 'code'; instructions: string; setup: Setup; model?: string; credentialKey: string; githubPermissions?: Record<string, 'read' | 'write'>; authMode: 'api-key' }
export interface FactoryConfig { project: string; database: string; roles: Record<string, Role> }
export interface AgentRequest { role: string; task: string; repository?: string; baseCommit?: string }
export interface AgentSnapshot {
  id: string; name: string; state: TaskRecord['state']; cancelRequested: boolean;
  result: unknown; recoveryRequired: boolean; attempts: ReturnType<WorkStore['attempts']>;
}
export interface AgentHandle {
  id: string;
  status(): TaskRecord['state'];
  inspect(): AgentSnapshot;
  permissions(): RolePermissions;
  cancel(): void;
  result(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
}
export class AgentRecoveryRequiredError extends Error {
  constructor(readonly agentId: string, readonly attemptId: string) {
    super(`Agent ${agentId} requires recovery for attempt ${attemptId}; work and resource ownership are unchanged`);
    this.name = 'AgentRecoveryRequiredError';
  }
}
/** Durable submission API consumed by the local coordinator. */
export function createFactory(config: FactoryConfig) {
  if (!config.project.trim()) throw new Error('Project is required');
  const project = config.project;
  const roles: Record<string, Role> = Object.fromEntries(Object.entries(config.roles).map(([name,role]) => {
    if (!name.trim() || role.kind !== 'code' || !role.instructions.trim()) throw new Error('New factory agents must use a coding role');
    if (role.model !== undefined && !/^[A-Za-z0-9_.:-]{1,160}$/.test(role.model)) throw new Error('Invalid model');
    authCredentialReference(role);
    if (role.kind === 'code' && !role.setup.capture.paths.includes('candidate.bundle')) throw new Error('Code roles must retain candidate.bundle');
    if (role.setup.secrets.length !== 1 || role.setup.secrets[0]?.key !== role.credentialKey) throw Error('Coding role requires its fixed Codex secret only');
    if (role.githubPermissions && (!Object.keys(role.githubPermissions).length || Object.entries(role.githubPermissions).some(([permission, level]) =>
      !/^[a-z_]+$/.test(permission) || !['read', 'write'].includes(level)))) throw Error('Invalid GitHub permission policy');
    return [name,{ kind: role.kind, instructions: role.instructions, setup: parseSetup(role.setup), credentialKey: role.credentialKey,
      ...(role.githubPermissions ? { githubPermissions: structuredClone(role.githubPermissions) } : {}),
      authMode: role.authMode, ...(role.model === undefined ? {} : { model: role.model }) }];
  }));
  const store = new WorkStore(config.database);
  function inspect(id: string): AgentSnapshot {
    const { task, attempts } = store.snapshot(id);
    if (task.project !== project) throw new Error('Agent belongs to a different project');
    return { id, name: task.name, state: task.state, cancelRequested: task.cancelRequested, result: task.result, recoveryRequired: attempts.some(attempt => attempt.recoveryRequired), attempts };
  }
  function handle(id: string): AgentHandle {
    if (store.get(id).project !== project) throw new Error('Agent belongs to a different project');
    return { id, status: () => store.get(id).state, inspect: () => inspect(id), permissions: () => describeRolePermissions(JSON.parse(store.get(id).input).role), cancel: () => store.requestCancel(id),
      async result(options = {}) {
        const deadline = Date.now() + (options.timeoutMs ?? 3_600_000);
        while (Date.now() < deadline) {
          options.signal?.throwIfAborted();
          const task = inspect(id);
          if (task.state === 'succeeded') return task.result;
          if (task.state === 'failed' || task.state === 'cancelled') throw new Error(`Agent ${task.state}`);
          const recovery = task.attempts.find(attempt => attempt.recoveryRequired);
          if (recovery) throw new AgentRecoveryRequiredError(id, recovery.id);
          await new Promise(resolve => setTimeout(resolve,100));
        }
        throw new Error('Result wait timed out; agent state is unchanged');
      },
    };
  }
  return {
    spawn(name: string, request: AgentRequest): AgentHandle {
      if (!name.trim() || !request.task.trim()) throw new Error('Agent name and task are required');
      const role = Object.hasOwn(roles,request.role) ? roles[request.role] : undefined; if (!role) throw new Error('Unknown role');
      if (role.kind === 'code' && (!request.repository || !/^[a-f0-9]{40}$/.test(request.baseCommit ?? ''))) throw new Error('Code agents require a repository and exact base commit');
      const record = store.submit(project,name,{ role, task: request.task,
        ...(request.repository === undefined ? {} : { repository: request.repository }),
        ...(request.baseCommit === undefined ? {} : { baseCommit: request.baseCommit }) });
      return handle(record.id);
    },
    permissions: (): Record<string, RolePermissions> => Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, describeRolePermissions(role)])),
    agent: handle,
    list: (): AgentSnapshot[] => store.list(project).map(task => inspect(task.id)),
    close: () => store.close(),
  };
}

export { startLocalCoordinator, type AttemptExecutor, type ExecutionContext } from './local-coordinator.js';
export { createTartExecutor, type FactoryJob, type TartExecutorOptions } from './tart-executor.js';
export { createGitHubJob, type GitHubJobOptions } from './github-job.js';
export { renderWorkerWorkflow } from './workflow.js';
export { buildWorkerBundle, createGuestStager } from './guest-stage.js';
export type { WorkerBundle } from './guest-stage.js';
export { createGuestRetainer } from './guest-retain.js';
export type { RetainedAttempt, InterruptedAttempt } from './guest-retain.js';
export { startFactory, type ControllerOptions } from './controller.js';

export { createCodeAcceptance, type CodeAcceptanceOptions } from './code-acceptance.js';
export { renderVerificationWorkflow } from './workflow.js';
export { validateAcceptanceChecks, type AcceptanceCheck } from './code-verifier.js';

export { createUsageReporter, type UsageReport, type UsageReporterOptions } from './usage-report.js';
export { createUsageLedger } from './usage-ledger.js';
export { sweBenchAgentRequest, prepareSweBenchCandidate, type SweBenchInstance } from './swe-bench.js';
export { createSweBenchBenchmark, type SweBenchBenchmarkOptions, type SweBenchBenchmarkResult } from './swe-bench-controller.js';
export type { SweBenchDatasetArtifact, SweBenchImage } from './swe-bench-job.js';


export { configureGitHubFactory, type GitHubFactoryOptions, type GitHubFactoryInfrastructure } from './github-factory.js';

export type { RolePermissions } from './permissions.js';
export { appAuthenticatedFetch, appRepositoryAcquisition, loadFactoryAppConfig, openFactoryApp } from './factory-app-auth.js';
export { createHostPublisher } from './host-publication.js';


export { checkCodeInstallation } from './installation-preflight.js';
export { parseAgentManifest, loadAgentManifest, prepareSourceBundles, type AgentManifest, type ConfiguredAgent } from './agent-manifest.js';
