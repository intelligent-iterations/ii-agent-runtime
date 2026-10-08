import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TargetOperations } from '../../../../src/providers/execution/shared/operations.js';
import { ProcessFailure } from '../../../../src/providers/shared/process.js';

test('target operations propagate Run cancellation, constrain time, and retain an independent cleanup budget', async () => {
  const controller = new AbortController();
  const calls: Array<{ timeoutMs: number; signal?: AbortSignal }> = [];
  const operations = new TargetOperations(async request => { calls.push(request); return ''; });
  operations.start(60, { deadlineMs: Date.now() + 1000, signal: controller.signal });
  const request = { command: 'test', args: [], cwd: '/tmp', env: {}, timeoutMs: 60000, maxOutputBytes: 100 };
  await operations.run(request);
  assert.ok(calls[0]!.timeoutMs <= 1000);
  controller.abort();
  assert.equal(calls[0]!.signal?.aborted, true);
  await assert.rejects(operations.run(request), error => error instanceof ProcessFailure && error.kind === 'canceled');
  await operations.cancel();
  await operations.run(request, true);
  assert.equal(calls[1]!.signal, undefined);
  assert.ok(calls[1]!.timeoutMs > 1000 && calls[1]!.timeoutMs <= 60000);
  await assert.rejects(operations.run(request), /canceled/);
});
