/* Generated from schemas/runtime-configuration.json. */

export type Repository = string;
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
   * Container isolation and the required, explicitly selected deployment target.
   */
  environment: {
    provider: 'docker' | 'openshell';
    /**
     * Required deployment target. The caller explicitly selects GitHub workflow compute or a supported VM cloud provider.
     */
    hosting:
      | {
          provider: 'github';
        }
      | {
          provider: 'aws' | 'azure' | 'gcp' | 'oci' | 'digitalocean' | 'hetzner';
          infrastructure: {};
          providerConfiguration: {};
          executorImage: string;
          ssh: {
            user: string;
            identityFile: string;
            knownHostsFile: string;
            port?: number;
          };
        };
    image: string;
    cpu: number;
    memoryMiB: number;
    /**
     * Setup execution settings before agent credentials are available. The caller selects the commands to execute.
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
   * Where the code lives. Selects the source host adapter; github is a GitHub App installation that issues short-lived, repository-scoped tokens. permissions is what the agent's token may do in the repository; it defaults to contents: write, for repository writes.
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
  limits: {
    enabled: boolean;
    maxConcurrent: number;
    /**
     * Maximum runs per caller-supplied subject identifier.
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
