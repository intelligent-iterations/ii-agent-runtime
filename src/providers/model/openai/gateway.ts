import { canonicalJson } from '../../../runtime/configuration.js';
import { createModelBudget, type ModelBudgetLimits } from '../../../runtime/model-budget.js';
import { observeCodexUsage, type ProviderUsage } from './usage.js';

const allowed = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'text',
  'max_output_tokens', 'stream', 'store', 'include', 'prompt_cache_key', 'metadata', 'service_tier', 'truncation']);
/** Sent by Codex (session IDs, workspace paths, analytics flags); accepted but never forwarded to the provider. */
const dropped = ['client_metadata'];
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid model request');
  return value as Record<string, unknown>;
}

/** Codex Responses protocol adapter. The API key stays in the trusted gateway process. */
export function codexModelGateway(options: {
  model: string; apiKey: () => string; limits: ModelBudgetLimits; signal: AbortSignal; fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const budget = createModelBudget(options.limits);
  const usage: ProviderUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let reportedRequests = 0;
  const prepare = (input: unknown) => {
    // Clone validated JSON to prevent a caller changing its model/input between counting and execution.
    const body = object(JSON.parse(canonicalJson(input)));
    for (const key of dropped) delete body[key];
    if (Object.keys(body).some(key => !allowed.has(key)) || body.model !== options.model ||
      body.input === undefined || (body.service_tier !== undefined && body.service_tier !== 'default') ||
      body.store === true || (body.stream !== undefined && body.stream !== true)) throw Error('Unsupported model request');
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 100 || body.tools.some(tool =>
      !['function', 'custom'].includes(String(object(tool).type))))) throw Error('Only local agent tools are permitted');
    const rejectRemoteInput = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(rejectRemoteInput); return; }
      const entry = object(value);
      if (['input_image', 'input_file', 'input_audio', 'item_reference'].includes(String(entry.type)) ||
        ['image_url', 'file_url', 'file_id', 'audio_url'].some(key => Object.hasOwn(entry, key))) throw Error('Remote and multimodal inputs are not enabled');
      Object.values(entry).forEach(rejectRemoteInput);
    };
    rejectRemoteInput(body.input);
    body.store = false;
    body.stream = true;
    body.service_tier = 'default';
    return body;
  };
  async function upstream(path: 'responses/input_tokens' | 'responses', body: unknown): Promise<Response> {
    const key = options.apiKey();
    if (!key || /[\r\n]/.test(key)) throw Error('Model credential unavailable');
    try {
      const response = await request(`https://api.openai.com/v1/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(120000)]),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      return response;
    } catch { throw Error('Model provider request failed'); }
  }
  return {
    snapshot: () => ({ ...budget.snapshot(), reportedRequests,
      usageComplete: budget.snapshot().generationRequests === reportedRequests, usage: { ...usage }, billingMode: 'metered_api' as const }),
    async respond(input: unknown): Promise<Response> {
      if (options.signal.aborted) throw Error('Agent execution ended');
      const body = prepare(input);
      const id = budget.begin();
      try {
        const countBody: Record<string, unknown> = {};
        for (const key of ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'text']) {
          if (body[key] !== undefined) countBody[key] = body[key];
        }
        const counted = await upstream('responses/input_tokens', countBody);
        const countReader = counted.body?.getReader();
        if (!countReader) throw Error('Missing provider token count');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const item = await countReader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > 4096) throw Error('Provider token count response too large');
            chunks.push(item.value);
          }
        } finally { await countReader.cancel().catch(() => {}); countReader.releaseLock(); }
        const countedBody = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (countedBody.object !== 'response.input_tokens' || typeof countedBody.input_tokens !== 'number') throw Error('Invalid provider token count');
        const maximum = budget.reserve(id, countedBody.input_tokens,
          body.max_output_tokens === undefined ? options.limits.maxOutputTokensPerRequest : Number(body.max_output_tokens));
        body.max_output_tokens = maximum.maxOutputTokens;
        const response = await upstream('responses', body);
        if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel(); throw Error('Invalid model stream');
        }
        const reader = response.body.getReader();
        let counters: ProviderUsage | undefined;
        const observer = observeCodexUsage(value => { counters = value; });
        let size = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                if (observer.complete() && counters) {
                  for (const key of Object.keys(usage) as Array<keyof ProviderUsage>) usage[key] += counters[key];
                  reportedRequests++;
                }
                controller.close(); reader.releaseLock(); return;
              }
              size += chunk.value.length;
              if (size > 16777216) throw Error('Model stream byte limit reached');
              observer.push(chunk.value);
              controller.enqueue(chunk.value);
            } catch {
              await reader.cancel().catch(() => {});
              controller.error(Error('Model stream interrupted'));
            }
          },
          async cancel() { await reader.cancel().catch(() => {}); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      } finally { budget.cancelBeforeGeneration(id); }
    },
  };
}
