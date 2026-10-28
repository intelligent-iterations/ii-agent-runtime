import type { RuntimeConfiguration } from '../src/runtime/configuration.js';

export function fixture(): RuntimeConfiguration {
  return {
    schemaVersion: 2, id: 'sample-agent', revision: '1', instructions: 'Make the requested change and verify the result.',
    harness: { name: 'codex', version: '0.156.1', model: 'example-model' },
    environment: { provider: 'docker', hosting: { provider: 'github' }, image: `example/agent@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
    source: { provider: 'github', repository: 'example/project', appId: 100, installationId: 200, additionalRepositories: [] },
    limits: { enabled: false, maxConcurrent: 1, maxRunsPerSubject: 1, maxRunsPerMonth: 10, timeoutMinutes: 5,
      maxModelRequests: 20, maxInputTokensPerRequest: 4096, maxOutputTokensPerRequest: 1024,
      maxModelCostMicrousdPerRun: 1000000, maxCostMicrousdPerMonth: 20000000,
      inputMicrousdPerMillionTokens: 2000000, outputMicrousdPerMillionTokens: 10000000, computeMicrousdPerMinute: 8000 },
  };
}
