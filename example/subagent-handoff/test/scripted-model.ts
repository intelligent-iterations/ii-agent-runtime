// Test doubles only. Product code (src/) talks to the real OpenAI API; tests answer in its place.
import type { ModelSession } from '../src/model.js';

type Item = Record<string, unknown>;
interface Request { model?: string; input?: Item[] }

const tokens = (value: unknown) => Math.ceil(JSON.stringify(value ?? '').length / 4);

/** Stream output items the way the Responses API does, so agents use one parser for every model. */
function stream(items: Item[], turn: number, request: Request): Response {
  const usage = { input_tokens: tokens(request.input), output_tokens: tokens(items) };
  const events = [...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
    { type: 'response.completed', response: { id: `resp_scripted_${turn}`, status: 'completed', output: items, usage } }];
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
 * Deterministic stand-in for a model. It follows a fixed script for the bundled sample project; it is not a
 * general coding model. It answers only requests for `model`.
 */
export function scriptedModel(policy: (request: Request, turn: number) => Item[], model = 'scripted'): ModelSession {
  let turn = 0;
  return { async respond(input) {
    const request = input as Request;
    if (request.model !== model) return new Response('Unsupported model', { status: 400 });
    return stream(policy(request, ++turn), turn, request);
  } };
}

export const scriptedPlanner = (project: string, script: string, model?: string) => scriptedModel((request, turn) => {
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
}, model);

export const scriptedCoder = (project: string, script: string, model?: string) => scriptedModel((request, turn) => {
  const seen = outputs(request);
  switch (seen.length) {
    case 0: return [call(turn, 'read-file', { project, path: 'src/cart.js' })];
    case 1: return [call(turn, 'write-file', { project, path: 'src/cart.js',
      content: String(seen[0]?.content ?? '').replace('sum + item.priceCents,', 'sum + item.priceCents * item.quantity,') })];
    case 2: return [call(turn, 'run-script', { project, script })];
    default: return [say(turn, `Updated src/cart.js to multiply by quantity. Test script exit code: ${seen[2]?.exitCode ?? 'unknown'}.`)];
  }
}, model);

export interface InterceptedCall { url: string; authorization: string | null }

/**
 * A `fetch` for the runtime's OpenAI adapter that never reaches the network: it answers the two endpoints the
 * adapter calls (input token count, then the streamed response) from `model`, and records every call.
 */
export function interceptOpenAI(model: ModelSession, calls: InterceptedCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    calls.push({ url: target, authorization: new Headers(init?.headers).get('authorization') });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (target === 'https://api.openai.com/v1/responses/input_tokens')
      return Response.json({ object: 'response.input_tokens', input_tokens: tokens(body.input) + tokens(body.instructions) + tokens(body.tools) });
    if (target === 'https://api.openai.com/v1/responses') return model.respond(body);
    return new Response('Not intercepted', { status: 404 });
  }) as typeof fetch;
}
