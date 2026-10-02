import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexModelGateway } from '../src/providers/codex-model.js';

const limits = { maxModelRequests: 3, maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 100,
  maxModelCostMicrousdPerRun: 600, inputMicrousdPerMillionTokens: 1000000, outputMicrousdPerMillionTokens: 2000000 };
const input = () => ({ model: 'synthetic-model', input: [{ role: 'user', content: 'test input' }], tools: [{ type: 'function', name: 'local_test', parameters: {} }] });

test('model gateway counts the same immutable request, reserves before generation and hides the real credential', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const controller = new AbortController();
  const gateway = codexModelGateway({ model: 'synthetic-model', apiKey: () => 'synthetic-upstream-key', limits, signal: controller.signal,
    fetch: async (url, request) => {
      assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer synthetic-upstream-key');
      calls.push({ url: String(url), body: JSON.parse(String(request?.body)) });
      if (String(url).endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      assert.equal(gateway.snapshot().reservedMicrousd, 300 * (calls.length / 2));
      return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  const request = input();
  const first = gateway.respond(request);
  request.input[0]!.content = 'changed after counting started';
  assert.match(await (await first).text(), /response.completed/);
  assert.deepEqual(calls[0]!.body.input, calls[1]!.body.input);
  assert.equal((calls[1]!.body.input as typeof request.input)[0]!.content, 'test input');
  assert.equal(calls[1]!.body.max_output_tokens, 100);
  assert.equal(calls[1]!.body.store, false);
  assert.equal(calls[1]!.body.service_tier, 'default');
  await (await gateway.respond(input())).text();
  await assert.rejects(gateway.respond(input()), /cost limit/);
  assert.equal(calls.filter(call => call.url.endsWith('/responses')).length, 2);
  assert.ok(!JSON.stringify(gateway.snapshot()).includes('synthetic-upstream-key'));
  controller.abort();
  await assert.rejects(gateway.respond(input()), /ended/);
});

test('billable built-in tools, remote inputs, alternate models and hidden response history are rejected before network access', async () => {
  let calls = 0;
  const gateway = codexModelGateway({ model: 'synthetic-model', apiKey: () => 'unused', limits, signal: new AbortController().signal,
    fetch: async () => { calls++; throw Error('Unexpected call'); } });
  for (const mutation of [ { model: 'other' }, { tools: [{ type: 'web_search' }] }, { previous_response_id: 'hidden' },
    { conversation: 'hidden' }, { service_tier: 'priority' }, { store: true },
    { input: [{ type: 'input_image', image_url: 'https://example.invalid/image' }] }, { input: [{ type: 'item_reference', id: 'hidden' }] },
  ]) await assert.rejects(gateway.respond({ ...input(), ...mutation }));
  assert.equal(calls, 0);
});

test('uncertain upstream execution is charged and never automatically retried; invalid counting cannot generate', async () => {
  for (const count of [-1, 1001, 10]) {
    let calls = 0;
    const gateway = codexModelGateway({ model: 'synthetic-model', apiKey: () => 'synthetic-secret', limits, signal: new AbortController().signal,
      fetch: async () => {
        calls++;
        if (calls === 1) return Response.json({ object: 'response.input_tokens', input_tokens: count });
        throw Error('Error containing synthetic-secret');
      } });
    await assert.rejects(gateway.respond(input()), error => { assert.ok(!String(error).includes('synthetic-secret')); return true; });
    assert.equal(calls, count === 10 ? 2 : 1);
    assert.equal(gateway.snapshot().reservedMicrousd, count === 10 ? 210 : 0);
  }
});

test('a real Codex 0.159.2 request passes the gateway, and its client metadata never reaches the provider', async () => {
  const { readFileSync } = await import('node:fs');
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/codex-0.159.2-gpt-6-luna-request.json', import.meta.url), 'utf8')).request;
  assert.ok(recorded.client_metadata, 'the recording carries the field Codex sends');
  const forwarded: Array<Record<string, unknown>> = [];
  const gateway = codexModelGateway({ model: 'gpt-6-luna', apiKey: () => 'synthetic-upstream-key', signal: new AbortController().signal,
    limits: { ...limits, maxInputTokensPerRequest: 65536, maxOutputTokensPerRequest: 8192, maxModelCostMicrousdPerRun: 250000 },
    fetch: async (url, request) => {
      forwarded.push(JSON.parse(String(request?.body)));
      if (String(url).endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 4321 });
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":4321,"output_tokens":7}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  await (await gateway.respond(recorded)).text();
  assert.equal(forwarded.length, 2);
  for (const body of forwarded) assert.equal(body.client_metadata, undefined);
  assert.deepEqual(forwarded[1]!.input, recorded.input, 'tools and instructions travel in input for this model family and are forwarded unchanged');
  assert.deepEqual(gateway.snapshot().usage, { inputTokens: 4321, cachedInputTokens: 0, outputTokens: 7, reasoningTokens: 0 });
});
