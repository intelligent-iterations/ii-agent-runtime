/**
 * The policy a new hub starts with. It names no worker image: each organization builds its own from
 * worker-image/Dockerfile and passes it to onboarding with --worker-image. In the hub policy format (see hub-policy.ts).
 * Prices are OpenAI's published standard short-context rates for gpt-6-astra ($10 input, $50 output per 1M tokens;
 * requests stay under the 272K long-context threshold) and GitHub's standard Linux runner rate. One maximum-size request
 * reserves about USD 1.07, so a run may spend USD 10 and a month USD 250.
 */
export function defaultPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 1, id: 'issue-agent', revision: '1',
    instructions: 'Implement the GitHub issue below in this repository. Keep the change focused, run the project\'s tests, then commit and push the task branch.',
    harness: { name: 'codex', version: '0.159.2', model: 'gpt-6-astra' },
    environment: { cpu: 2, memoryMiB: 4096 },
    github: { additionalRepositories: [] },
    launchPolicy: { mode: 'authorized-author', minimumPermission: 'write' },
    limits: { enabled: true, maxConcurrent: 1, maxRunsPerIssue: 1, maxRunsPerMonth: 20, maxWorkflowRunNumber: 100, maxWorkflowAttempts: 1,
      timeoutMinutes: 15, maxModelRequests: 50, maxInputTokensPerRequest: 65536, maxOutputTokensPerRequest: 8192,
      maxModelCostMicrousdPerRun: 10000000, maxCostMicrousdPerMonth: 250000000,
      inputMicrousdPerMillionTokens: 10000000, outputMicrousdPerMillionTokens: 50000000, runnerMicrousdPerMinute: 6000 },
    artifacts: { retentionDays: 7, maxBytes: 1048576 },
  };
}
