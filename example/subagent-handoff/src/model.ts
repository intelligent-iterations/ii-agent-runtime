import { executionServices } from '@intelligent-iterations/ii-agent-runtime/pipeline';

/** One Responses API call. Each agent's gateway forwards the agent's model requests to one of these. */
export interface ModelSession { respond(input: unknown): Promise<Response> }

export interface LiveModelConfig {
  model: string;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
}

/** Limits for one agent run. Every agent run gets its own model gateway, so these apply per agent. */
export const MODEL_LIMITS = {
  maxModelRequests: 16, maxInputTokensPerRequest: 64_000, maxOutputTokensPerRequest: 4_000, maxModelCostMicrousdPerRun: 1_000_000,
} as const;

/**
 * The most one agent run can reserve at these rates, in micro-USD: the $1 cap, or 16 worst-case requests if those
 * cost less. Each request reserves its counted input plus the output limit, the same way the gateway does.
 */
export function agentCostCeilingMicrousd(config: LiveModelConfig): number {
  const request = Math.ceil((MODEL_LIMITS.maxInputTokensPerRequest * config.inputMicrousdPerMillionTokens +
    MODEL_LIMITS.maxOutputTokensPerRequest * config.outputMicrousdPerMillionTokens) / 1_000_000);
  return Math.min(MODEL_LIMITS.maxModelCostMicrousdPerRun, MODEL_LIMITS.maxModelRequests * request);
}

export const dollars = (microusd: number) => `$${(microusd / 1_000_000).toFixed(microusd > 0 && microusd < 10_000 ? 4 : 2)}`;

export type LiveModelSession = ModelSession & {
  snapshot(): ReturnType<ReturnType<typeof executionServices.codexModelGateway>['snapshot']>;
};

/**
 * The runtime's OpenAI Responses adapter (`executionServices.codexModelGateway`) with this example's limits. The API
 * key stays in this trusted process; agents get only a gateway token. `fetch` is for tests, which intercept the
 * adapter's calls to api.openai.com; the CLI never passes it.
 */
export function liveModel(config: LiveModelConfig, signal: AbortSignal, options: { fetch?: typeof fetch } = {}): LiveModelSession {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Error('Set OPENAI_API_KEY on the trusted host for a live run');
  for (const key of ['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw Error(`Set ${key} to the selected model rate`);
  const gateway = executionServices.codexModelGateway({ model: config.model, apiKey: () => apiKey, signal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    limits: { ...MODEL_LIMITS, inputMicrousdPerMillionTokens: config.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: config.outputMicrousdPerMillionTokens } });
  return {
    snapshot: gateway.snapshot,
    async respond(input) {
      try { return await gateway.respond(input); } catch (error) {
        // The agent only sees HTTP 502. Show the gateway's reason (for example a budget limit) on the trusted host.
        const reason = error instanceof Error ? error.message : 'unknown error';
        process.stderr.write(`Model gateway refused a request: ${reason}` + (reason === 'Model provider request failed'
          ? ` (OpenAI rejected or did not answer it: check that OPENAI_API_KEY is valid and that your OpenAI project can use ${config.model})\n` : '\n'));
        throw error;
      }
    },
  };
}

/** What OpenAI reported for these agent runs, priced at the configured rates. */
export function usageSummary(sessions: readonly LiveModelSession[], config: LiveModelConfig): string {
  const shots = sessions.map(session => session.snapshot());
  const sum = (pick: (shot: (typeof shots)[number]) => number) => shots.reduce((total, shot) => total + pick(shot), 0);
  const input = sum(shot => shot.usage.inputTokens), output = sum(shot => shot.usage.outputTokens);
  // Cached input is billed lower than the input rate, so this is an upper bound at the configured rates.
  const cost = Math.ceil((input * config.inputMicrousdPerMillionTokens + output * config.outputMicrousdPerMillionTokens) / 1_000_000);
  const count = (value: number) => value.toLocaleString('en-US');
  return `Model use reported by OpenAI: ${sum(shot => shot.generationRequests)} request(s) from ${sessions.length} agent run(s), ` +
    `${count(input)} input tokens (${count(sum(shot => shot.usage.cachedInputTokens))} cached), ${count(output)} output tokens: ` +
    `at most ${dollars(cost)} at the configured rates; the gateways reserved ${dollars(sum(shot => shot.reservedMicrousd))}.` +
    (shots.every(shot => shot.usageComplete) ? '' : ' Some requests reported no usage, so the reservation is the upper bound.');
}
