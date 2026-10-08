import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeCodexUsage } from '../../../../src/providers/model/openai/usage.js';

test('provider usage survives arbitrary stream boundaries without retaining model text or treating missing usage as zero', () => {
  const event = { type: 'response.completed', response: { output: 'synthetic private content', usage: {
    input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 },
  } } };
  const bytes = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
  for (const step of [1, 2, 7, 23, 1000]) {
    const counts: unknown[] = [];
    const observer = observeCodexUsage(value => counts.push(value));
    for (let offset = 0; offset < bytes.length; offset += step) observer.push(bytes.subarray(offset, offset + step));
    assert.equal(observer.complete(), true);
    assert.deepEqual(counts, [{ inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, reasoningTokens: 10 }]);
    observer.push(bytes);
    assert.equal(observer.complete(), false);
  }
  const absent = observeCodexUsage(() => assert.fail('No fabricated usage'));
  absent.push(Buffer.from('data: {"type":"response.failed"}\n\n'));
  assert.equal(absent.complete(), false);
});
