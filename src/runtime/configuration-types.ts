/* Generated from schemas/runtime-configuration.json. */

export type Repository = string;
export type Permission = 'read' | 'triage' | 'write' | 'maintain' | 'admin';
export type Cost = number;

export interface RuntimeConfiguration {
  schemaVersion: 2;
  id: string;
  revision: string;
  instructions: string;
  /**
   * Which agent runs in the worker, and the model it uses. Selects the harness and model provider adapters.
   */
  harness: {
    name: 'codex';
    version: string;
    model: string;
  };
  /**
   * Where the agent runs. Selects the execution target adapter; docker is a hardened container on the machine that runs the pipeline.
   */
  environment: {
    provider: 'docker' | 'openshell';
    image: string;
    cpu: number;
    memoryMiB: number;
    /**
     * Dependency installation before the agent starts, with internet access and no credentials in the worker. Defaults to enabled, detected from the repository's lockfiles.
     */
    setup?: {
      enabled: boolean;
      timeoutMinutes?: number;
      /**
       * @minItems 1
       * @maxItems 10
       */
      commands?: string[];
    };
  };
  /**
   * Where the code lives. Selects the source host adapter; github is a GitHub App installation that issues short-lived, repository-scoped tokens. permissions is what the agent's token may do in the repository; it defaults to contents: write, enough to push a task branch.
   */
  source: {
    provider: 'github';
    repository: Repository;
    appId: number;
    installationId: number;
    permissions?: RepositoryPermissions;
    /**
     * Also require the App itself to be owned by the repository's owner, not only installed there.
     */
    requireAppOwner?: boolean;
    /**
     * @maxItems 10
     */
    additionalRepositories: {
      repository: Repository;
      permissions: RepositoryPermissions;
    }[];
  };
  launchPolicy:
    | {
        mode: 'authorized-author';
        minimumPermission: Permission;
      }
    | {
        mode: 'maintainer-approval';
        minimumPermission: Permission;
        label: string;
      }
    | {
        mode: 'any-author';
        allowPublicContributors: true;
      };
  limits: {
    enabled: boolean;
    maxConcurrent: number;
    /**
     * Runs one task subject (for example one issue) may start.
     */
    maxRunsPerSubject: number;
    maxRunsPerMonth: number;
    /**
     * At most 55, so a run ends before its one-hour source tokens expire.
     */
    timeoutMinutes: number;
    /**
     * Minutes the host spends around each run (start-up, evidence upload, teardown), reserved with the run. Defaults to 0.
     */
    overheadMinutes?: number;
    maxModelRequests: number;
    maxInputTokensPerRequest: number;
    maxOutputTokensPerRequest: number;
    maxModelCostMicrousdPerRun: Cost;
    maxCostMicrousdPerMonth: Cost;
    inputMicrousdPerMillionTokens: Cost;
    outputMicrousdPerMillionTokens: Cost;
    /**
     * What one minute of the execution host costs, reserved for the run and its overhead.
     */
    computeMicrousdPerMinute: number;
  };
}
export interface RepositoryPermissions {
  contents?: 'read' | 'write';
  issues?: 'read' | 'write';
  pull_requests?: 'read' | 'write';
}
