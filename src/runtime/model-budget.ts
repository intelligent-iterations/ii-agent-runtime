export interface ModelBudgetLimits {
  maxModelRequests: number;
  maxInputTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxModelCostMicrousdPerRun: number;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
}

/** Owned by the trusted gateway. Workers never receive the upstream provider credential. */
export function createModelBudget(limits: ModelBudgetLimits) {
  for (const value of [limits.maxModelRequests, limits.maxInputTokensPerRequest, limits.maxOutputTokensPerRequest,
    limits.maxModelCostMicrousdPerRun, limits.inputMicrousdPerMillionTokens, limits.outputMicrousdPerMillionTokens]) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid model budget');
  }
  let attempts = 0;
  let reserved = 0n;
  let generated = 0;
  const pending = new Set<number>();
  return {
    begin(): number {
      if (attempts >= limits.maxModelRequests) throw Error('Model request limit reached');
      const id = ++attempts;
      pending.add(id);
      return id;
    },
    reserve(id: number, inputTokens: number, requestedOutputTokens: number): { maxOutputTokens: number; reservedMicrousd: number } {
      if (!pending.delete(id)) throw Error('Unknown or replayed model request');
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > limits.maxInputTokensPerRequest ||
        !Number.isSafeInteger(requestedOutputTokens) || requestedOutputTokens < 1) throw Error('Model token limit exceeded');
      const output = Math.min(requestedOutputTokens, limits.maxOutputTokensPerRequest);
      const cost = (BigInt(inputTokens) * BigInt(limits.inputMicrousdPerMillionTokens) +
        BigInt(output) * BigInt(limits.outputMicrousdPerMillionTokens) + 999999n) / 1000000n;
      if (reserved + cost > BigInt(limits.maxModelCostMicrousdPerRun)) throw Error('Model cost limit reached');
      // A disconnected or failed generation may still be billed. Never refund its reservation.
      reserved += cost;
      generated++;
      return { maxOutputTokens: output, reservedMicrousd: Number(cost) };
    },
    cancelBeforeGeneration(id: number): void { pending.delete(id); },
    snapshot() { return { attempts, generationRequests: generated, reservedMicrousd: Number(reserved) }; },
  };
}
