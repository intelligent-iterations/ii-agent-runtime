export interface ProviderUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }

/** Extract only provider-reported counters; discard prompts, tool arguments and generated text. */
export function observeCodexUsage(record: (usage: ProviderUsage) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let data: string[] = [];
  let recorded = false;
  let invalid = false;
  const integer = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('Invalid usage counter');
    return value;
  };
  const dispatch = () => {
    const content = data.join('\n'); data = [];
    if (!content || content === '[DONE]') return;
    const event = JSON.parse(content) as Record<string, any>;
    if (!['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) return;
    if (recorded) throw Error('Duplicate provider usage');
    const usage = event.response?.usage;
    if (!usage) return;
    const counters = { inputTokens: integer(usage.input_tokens), outputTokens: integer(usage.output_tokens),
      cachedInputTokens: integer(usage.input_tokens_details?.cached_tokens ?? 0),
      reasoningTokens: integer(usage.output_tokens_details?.reasoning_tokens ?? 0) };
    if (counters.cachedInputTokens > counters.inputTokens || counters.reasoningTokens > counters.outputTokens) throw Error('Inconsistent provider usage');
    record(counters); recorded = true;
  };
  return {
    push(chunk: Uint8Array): void {
      if (invalid) return;
      try {
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length + data.join('').length > 1048576) throw Error('Usage frame limit');
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, '');
          buffered = buffered.slice(newline + 1);
          if (!line) dispatch();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      } catch { invalid = true; }
    },
    complete(): boolean { return recorded && !invalid; },
  };
}
