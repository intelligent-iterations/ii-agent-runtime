/* Generated from schemas/runtime-configuration.json. */

export type Repository = string;
export type Cost = number;

export interface RuntimeConfiguration {
  /**
   * User-declared activation metadata for advisory authority analysis. Does not install or enforce triggers.
   *
   * @maxItems 128
   */
  invokers?: {
    id: string;
    event: string;
    match: {
      /**
       * @minItems 1
       * @maxItems 256
       */
      [k: string]: (string | number | boolean)[];
    };
    /**
     * @maxItems 128
     */
    conditions?: string[];
  }[];
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
     * Bounded disk-backed workspace capacity. Targets without enforceable storage reject this requirement.
     */
    diskGiB?: number;
    /**
     * Require nested unprivileged namespace support for an external harness sandbox. Unsupported targets fail closed.
     */
    userNamespaces?: boolean;
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
   * Approved credential references and trusted assignments; values remain with the selected provider.
   *
   * @maxItems 128
   */
  credentialBindings?: {
    provider: string;
    resource: string;
    key: string;
    assignment: string;
  }[];
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
     * Maximum wall-clock budget for one run. Credential providers independently enforce grant expiry.
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
