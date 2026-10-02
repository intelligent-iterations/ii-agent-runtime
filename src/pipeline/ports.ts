import type { AdmissionResult } from '../runtime/admission.js';
import type { CompiledConfiguration } from '../runtime/configuration.js';

/**
 * Provider-neutral contracts of an agent pipeline. The configuration chooses where the agent runs
 * (`environment.provider`), which code host it works against (`source.provider`) and which harness runs it
 * (`harness.name`); the consumer chooses how tasks arrive (the trigger). Adapters implement these ports and are
 * selected only by the composition root in create-pipeline.ts.
 */

/** The work requested, as the intake verified it. Never trusted for authority; that is what `Authorization` carries. */
export interface PipelineTask {
  /** Short and branch-safe, chosen by the intake, for example `issue-13`; it names the task branch. */
  reference: string;
  /** How people refer to the task, for example `Issue #13`; shown to the agent. */
  label: string;
  title: string;
  body: string;
}

export interface Authorization {
  allowed: boolean;
  /** Stable refusal code, for example `author-denied`; explained to people by the consumer. */
  reason: string;
  decision: unknown;
  subjectId: string;
  inputDigest: string;
  task: PipelineTask;
  /** Branch to start from and deliver into; undefined means the repository's default branch. */
  base?: string;
  defaultBranch?: string;
}

/** Where a task came from (an issue, a ticket, a message): who asked, whether they may, and the shared run budget. */
export interface Intake {
  /** Identifies this run to the intake; with `attempt`, unique for every launch. Letters, digits and hyphens. */
  readonly runId: string;
  readonly attempt: number;
  /** The run budget all launches through this intake share. */
  readonly resource: string;
  /** First check, with read-only access. A denial is a normal outcome, not an error. */
  authorize(): Promise<Authorization>;
  /** Checked again just before execution. Not allowed when authority or input changed since `authorize`. */
  confirm(first: Authorization): Promise<Authorization>;
  admit(first: Authorization, policyDigest: string, now: number): Promise<AdmissionResult>;
  /** True when a failure meant the source host could not reach the target at all, which the consumer may explain. */
  readonly unreachable?: boolean;
}

/** A credential the worker gateway may use for one repository, never handed to the worker itself. */
export interface RepositoryGrant { repository: string; token: string; permissions: Record<string, string>; repositoryId: number; expiresAt: string }

export interface PushResult { verified: boolean; branch?: string; base?: string; commits?: number; files?: number }
export interface ChangeRequest { number: number; url: string }
export class ChangeRequestRefused extends Error {
  constructor(readonly status: number, readonly reason: string) { super(`Change request refused (HTTP ${status})`); }
}

/** Where the code lives: access for the worker, and what reached it afterwards. */
export interface SourceHost {
  /** Names the host's credentials in the cleanup report, for example `github-tokens`. */
  readonly name: string;
  /** The repository the run changes, as the host names it. */
  readonly target: string;
  /** Who the agent's commits are authored as. */
  readonly author: { name: string; email: string };
  /**
   * How the worker reaches code through the gateway at `endpoint`: git remotes under `remotePrefix` are served at
   * `gatewayPrefix`, and `notes` tell the agent what else it can reach there.
   */
  workerAccess(endpoint: string): { remotePrefix: string; gatewayPrefix: string; notes: string };
  baseExists(base: string): Promise<boolean>;
  /** A read-only copy of the base branch on the trusted host, for loading into the worker. */
  checkout(base?: string): Promise<{ directory: string; dispose(): Promise<void> }>;
  /** Credentials for the worker gateway. Afterwards the host key is dropped; no new credential can be minted. */
  workerGrants(): Promise<RepositoryGrant[]>;
  /** Whether a change request can be opened; false when the host credential lacks the permission. */
  canDeliver(): boolean;
  verifyPush(branch: string, base: string): Promise<PushResult>;
  openChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest>;
  close(): Promise<void>;
}

/** The worker's network once isolated: it reaches only `address`, and only after `connect`. */
export interface Isolation { address: string; connect(port: number): Promise<void>; close(): Promise<void> }
export interface SetupResult { label: string; exitCode: number; seconds: number; timedOut: boolean }
export interface Worker {
  /** Opaque handle the matching harness understands. */
  readonly handle: unknown;
  /** Copies the checked-out repository into the worker's workspace. */
  load(directory: string): Promise<void>;
  /** Installs dependencies with internet access. Runs before any credential exists, and leaves the worker detached. */
  setup(commands: string[], options: { timeoutMs: number; signal: AbortSignal }): Promise<Omit<SetupResult, 'label'>>;
  isolate(): Promise<Isolation>;
}
/** Where the agent runs: a hardened local container today; a cloud or remote machine are further adapters. */
export interface ExecutionTarget { provision(compiled: CompiledConfiguration): Promise<Worker>; close(): Promise<void> }

export interface ModelSession {
  respond(input: unknown): Promise<Response>;
  /** Usage so far; `billingMode` says how the provider charges for it, for example `metered_api`. */
  snapshot(): { usageComplete: boolean; billingMode: string } & Record<string, unknown>;
}
/** Which model service answers the harness, with spend limits enforced outside the worker. */
export interface ModelProvider { open(signal: AbortSignal): ModelSession }

export interface WorkerResult { exitCode: number; head: string; dirty: boolean; branch: string; activity?: unknown }
/** Which agent runs inside the worker, and how its result is read back. */
export interface Harness {
  execute(worker: Worker, input: {
    endpoint: string; token: string; task: PipelineTask;
    /** The task branch the agent pushes, and the branch it starts from. */
    branch: string; base?: string;
    /** Whether the pipeline proposes the pushed work for review itself, so the agent can say so and need not. */
    delivered: boolean;
    author: SourceHost['author']; access: ReturnType<SourceHost['workerAccess']>;
    setup?: SetupResult; timeoutMs: number; signal: AbortSignal;
  }): Promise<WorkerResult>;
}

export type PipelineEvent =
  | { type: 'target-unreachable' }
  | { type: 'denied'; reason: string; stage: 'authorization' | 'admission' }
  | { type: 'missing-base'; base: string }
  | { type: 'started' };

export interface PipelineOutcome {
  report: Record<string, unknown>;
  /** True once the run was admitted and announced. */
  started: boolean;
  failed: boolean;
}

export class UnsupportedPipelineTarget extends Error {
  constructor(readonly setting: string, readonly value: unknown) { super(`No pipeline adapter for ${setting} ${JSON.stringify(value)}`); }
}
