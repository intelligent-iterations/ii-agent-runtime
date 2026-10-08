import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerWorkerCommand } from '../../../../src/providers/execution/docker/command.js';

const worker = { owner: 'a'.repeat(32), containerId: 'b'.repeat(64), networkId: 'c'.repeat(64), directory: '/owned' };

test('Docker command transport fixes identity and environment and preserves bounded stdin execution', async () => {
  const controller = new AbortController();
  const input = '$(never-execute)\nprivate per-run input';
  const run = dockerWorkerCommand(worker, { executablePath: '/trusted/bin', process: async request => {
    assert.equal(request.command, 'docker');
    assert.deepEqual(request.args, ['exec', '--interactive', '--user', '10001:10001', worker.containerId, 'node', '-e', 'program']);
    assert.deepEqual(request.env, { HOME: '/owned', PATH: '/trusted/bin' });
    assert.equal(request.cwd, '/owned');
    assert.equal(request.input, input);
    assert.equal(request.timeoutMs, 1234);
    assert.equal(request.maxOutputBytes, 5678);
    assert.equal(request.signal, controller.signal);
    return 'result';
  } });
  assert.equal(await run({ command: 'node', args: ['-e', 'program'], input,
    timeoutMs: 1234, maxOutputBytes: 5678, signal: controller.signal }), 'result');
});

test('Docker transport refuses malformed container identities before starting a process', () => {
  for (const containerId of ['', '--privileged', 'b'.repeat(63), 'B'.repeat(64)]) {
    assert.throws(() => dockerWorkerCommand({ ...worker, containerId }), /Invalid Docker worker identity/);
  }
});
