import { executionServices } from '@intelligent-iterations/ii-agent-runtime/pipeline';

export interface ModelSession { respond(input: unknown): Promise<Response> }
type Item = Record<string, unknown>;
interface Request { model?: string; input?: Item[] }

/** Stream output items the way the Responses API does, so agents use one parser for both models. */
function stream(items: Item[], turn: number): Response {
  const events = [...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
    { type: 'response.completed', response: { id: `resp_scripted_${turn}`, status: 'completed', output: items } }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
const call = (turn: number, name: string, args: unknown): Item =>
  ({ type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name, arguments: JSON.stringify(args), status: 'completed' });
const say = (turn: number, text: string): Item =>
  ({ type: 'message', id: `msg_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const outputs = (request: Request) => (request.input ?? []).filter(item => item.type === 'function_call_output')
  .map(item => { try { return JSON.parse(String(item.output)); } catch { return { error: String(item.output) }; } });

/**
 * Deterministic stand-in for a model, used by tests and `npm run demo`. It follows a fixed
 * script for the bundled sample project; it is not a general coding model.
 */
export function scriptedModel(policy: (request: Request, turn: number) => Item[]): ModelSession {
  let turn = 0;
  return { async respond(input) {
    const request = input as Request;
    if (request.model !== 'scripted') return new Response('Unsupported model', { status: 400 });
    return stream(policy(request, ++turn), turn);
  } };
}

export const scriptedPlanner = (project: string, script: string) => scriptedModel((request, turn) => {
  const seen = outputs(request);
  switch (seen.length) {
    case 0: return [call(turn, 'run-script', { project, script })];
    case 1: return [call(turn, 'read-file', { project, path: 'test/cart.test.js' })];
    case 2: return [call(turn, 'read-file', { project, path: 'src/cart.js' })];
    case 3: return [call(turn, 'handoff-to-coder', { project, summary: 'cartTotal ignores item quantity',
      plan: 'In src/cart.js, cartTotal adds priceCents once per item. Multiply each priceCents by its quantity, keep the rest unchanged, then run the test script.',
      files: ['src/cart.js'] })];
    default: return [say(turn, seen[3]?.accepted ? 'The failing test expects quantities to be counted. I handed the fix for src/cart.js to the coder.'
      : `The handoff was not accepted: ${JSON.stringify(seen[3])}`)];
  }
});

export const scriptedCoder = (project: string, script: string) => scriptedModel((request, turn) => {
  const seen = outputs(request);
  switch (seen.length) {
    case 0: return [call(turn, 'read-file', { project, path: 'src/cart.js' })];
    case 1: return [call(turn, 'write-file', { project, path: 'src/cart.js',
      content: String(seen[0]?.content ?? '').replace('sum + item.priceCents,', 'sum + item.priceCents * item.quantity,') })];
    case 2: return [call(turn, 'run-script', { project, script })];
    default: return [say(turn, `Updated src/cart.js to multiply by quantity. Test script exit code: ${seen[2]?.exitCode ?? 'unknown'}.`)];
  }
});

export interface LiveModelConfig {
  model: string;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
}

/** The runtime's OpenAI Responses adapter. The API key stays in this trusted process; agents get a gateway token. */
export function liveModel(config: LiveModelConfig, signal: AbortSignal): ModelSession {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Error('Set OPENAI_API_KEY on the trusted host for a live run');
  for (const key of ['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw Error(`Set ${key} to the selected model rate`);
  const gateway = executionServices.codexModelGateway({ model: config.model, apiKey: () => apiKey, signal, limits: {
    maxModelRequests: 16, maxInputTokensPerRequest: 64_000, maxOutputTokensPerRequest: 4_000, maxModelCostMicrousdPerRun: 1_000_000,
    inputMicrousdPerMillionTokens: config.inputMicrousdPerMillionTokens, outputMicrousdPerMillionTokens: config.outputMicrousdPerMillionTokens } });
  return {
    async respond(input) {
      try { return await gateway.respond(input); } catch (error) {
        // The agent only sees HTTP 502. Show the gateway's reason (for example a budget limit) on the trusted host.
        process.stderr.write(`Model gateway refused a request: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        throw error;
      }
    },
  };
}
