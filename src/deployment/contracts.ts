/** Host infrastructure declarations. Credentials are supplied at execution, never compiled. */
export interface HostDeployment {
  schemaVersion: 1;
  id: string;
  provider: string;
  /** Provider-specific location, existing network, image and size choices belong to the adapter. */
  infrastructure: Record<string, unknown>;
  /** Provider configuration without authentication material. Authentication comes from the operator environment. */
  providerConfiguration: Record<string, unknown>;
}
export interface DeploymentArtifact {
  kind: 'execution-host';
  schemaVersion: 1;
  id: string;
  provider: string;
  configurationDigest: string;
  /** Compiled files contain no credentials. IaC state must still be held privately. */
  files: Record<string, string>;
  evidence: { compilation: 'passed'; schemaValidation: 'not-run'; emulator: 'not-run'; live: 'not-run' };
}
export class UnsupportedDeployment extends Error {
  constructor(
    readonly provider: string,
    readonly guarantee: string,
  ) {
    super(`Deployment ${provider} cannot provide ${guarantee}`);
  }
}
