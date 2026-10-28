
/** Execution contracts implemented by infrastructure and harness adapters. */
/** A credential the worker gateway may use for one repository, never handed to the worker itself. */
export interface RepositoryGrant { repository: string; token: string; permissions: Record<string, string>; repositoryId: number; expiresAt: string }

/** The worker's network once isolated: it reaches only `address`, and only after `connect`. */
export interface Isolation { address: string; connect(port: number): Promise<string | void>; close(): Promise<void> }
export interface SetupResult { label: string; exitCode: number; seconds: number; timedOut: boolean }
/** A bounded command inside the worker. Host paths, environment and provider handles stay in the adapter. */
export interface WorkerCommand {
  command: string;
  args: string[];
  input?: string | Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
export type WorkerCommandRunner = (request: WorkerCommand) => Promise<string>;
export interface Worker {
  /** Absolute writable root provided by the target. */
  readonly workspace: string;
  /** Runs as the unprivileged workload identity, with input on stdin and bounded output. */
  run: WorkerCommandRunner;
  /** Copies the supplied directory into the worker's workspace. */
  load(directory: string): Promise<void>;
  /** Installs dependencies with internet access. Runs before workload credentials are issued, and returns with setup networking sealed. */
  setup(commands: string[], options: { timeoutMs: number; signal: AbortSignal }): Promise<Omit<SetupResult, 'label'>>;
  isolate(): Promise<Isolation>;
}
/** Agent resources enforced by the explicitly selected execution target. */
export interface WorkerResources { image: string; cpu: number; memoryMiB: number; timeoutSeconds: number; configurationDigest: string }
/** The caller's Run deadline and cancellation apply to acquisition, not final cleanup. */
export interface ExecutionContext { deadlineMs: number; signal: AbortSignal }
export interface ExecutionTarget { provision(resources: WorkerResources, context?: ExecutionContext): Promise<Worker>; close(): Promise<void> }

export interface ModelSession {
  respond(input: unknown): Promise<Response>;
  /** Usage so far; `billingMode` says how the provider charges for it, for example `metered_api`. */
  snapshot(): { usageComplete: boolean; billingMode: string } & Record<string, unknown>;
}
/** Which model service answers the harness, with spend limits enforced outside the worker. */
export interface ModelProvider { open(signal: AbortSignal): ModelSession }

export class UnsupportedPipelineTarget extends Error {
  constructor(readonly setting: string, readonly value: unknown) { super(`No pipeline adapter for ${setting} ${JSON.stringify(value)}`); }
}
