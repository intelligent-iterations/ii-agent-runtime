// Generated from schemas/setup.json. Run npm run generate:types; do not edit.

export interface Setup {
  schemaVersion: 1;
  id: string;
  revision: string;
  harness: {
    name: string;
    version: string;
  };
  deployment: {
    provider: string;
    image: string;
    cpu: number;
    memoryMiB: number;
    /**
     * Data-only provider options. Validated by the selected adapter and bound into the setup digest.
     */
    options?: {
      [k: string]: unknown;
    };
  };
  /**
   * @maxItems 128
   */
  secrets: (
    | {
        provider: 'github';
        repository: string;
        environment?: string;
        organization?: string;
        key: string;
      }
    | {
        provider: string;
        resource: string;
        key: string;
      }
  )[];
  capture: {
    /**
     * @maxItems 128
     */
    paths: string[];
  };
}
