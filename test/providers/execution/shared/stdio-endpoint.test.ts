import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openWorkerStdioEndpoint } from '../../../../src/providers/execution/shared/stdio-endpoint.js';
import { openTrustedProcess } from '../../../../src/providers/shared/process-session.js';
import { runTrustedProcess } from '../../../../src/providers/shared/process.js';
import type { WorkerSessionCommand } from '../../../../src/pipeline/ports.js';

function temporary(t: { after(fn: () => void): void }) {
  const parent = mkdtempSync(join(realpathSync('/tmp'), 'ar-stdio-'));
  const owner = randomUUID();
  writeFileSync(join(parent, '.owner'), owner, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(parent, '.owner'), 'utf8'), owner); rmSync(parent, { recursive: true }); });
  return parent;
}
const request: WorkerSessionCommand = { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'],
  timeoutMs: 15000, maxInputBytes: 4096, maxOutputBytes: 4096 };

test('long-run endpoint budgets reach a real worker session without resetting the deadline', async t => {
  const parent = temporary(t);
  for (const timeoutMs of [5400000, 7200000]) {
    let observed = 0;
    const endpoint = await openWorkerStdioEndpoint({ open: command => {
      observed = command.timeoutMs;
      return openTrustedProcess({ ...command, cwd: parent, env: {} });
    } }, { ...request, timeoutMs }, { parent });
    try {
      const output = await runTrustedProcess({ command: endpoint.command, args: endpoint.args,
        input: 'bounded', cwd: parent, env: {}, timeoutMs: 3000, maxOutputBytes: 4096 });
      assert.equal(output, 'bounded');
      assert.deepEqual(await endpoint.completion, { exitCode: 0 });
      assert.ok(observed > 3600000 && observed <= timeoutMs);
    } finally { await endpoint.close(); }
  }
  await assert.rejects(openWorkerStdioEndpoint({ open: () => assert.fail('must not launch') },
    { ...request, timeoutMs: 7200001 }, { parent }), /Invalid endpoint deadline/);
  assert.deepEqual(readdirSync(parent), ['.owner']);
});

test('private endpoint connects a real stdio client to worker transport and removes owned socket state', async t => {
  const parent = temporary(t);
  let opens = 0;
  const endpoint = await openWorkerStdioEndpoint({ open: command => {
    opens++;
    return openTrustedProcess({ ...command, cwd: parent, env: {} });
  } }, request, { parent });
  try {
    const socket = endpoint.args.at(-1)!;
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal(statSync(join(socket, '..')).mode & 0o777, 0o700);
    const output = await runTrustedProcess({ command: endpoint.command, args: endpoint.args,
      input: 'protocol-roundtrip', cwd: parent, env: {}, timeoutMs: 3000, maxOutputBytes: 4096 });
    assert.deepEqual(await endpoint.completion, { exitCode: 0 });
    assert.equal(output, 'protocol-roundtrip');
    assert.equal(opens, 1);
    // A second caller cannot start another executor with the same endpoint.
    await runTrustedProcess({ command: endpoint.command, args: endpoint.args,
      input: 'second', cwd: parent, env: {}, timeoutMs: 1000, maxOutputBytes: 4096 }).catch(() => 'rejected');
    assert.equal(opens, 1);
  } finally { await endpoint.close(); }
  assert.deepEqual(readdirSync(parent), ['.owner']);
});

test('unsupported duplex execution fails before allocating a listener', async t => {
  const parent = temporary(t);
  await assert.rejects(openWorkerStdioEndpoint({}, request, { parent }), /duplex-command-unavailable/);
  assert.deepEqual(readdirSync(parent), ['.owner']);
});

test('an unused endpoint expires and can be cleaned without launching a worker', async t => {
  const parent = temporary(t);
  const endpoint = await openWorkerStdioEndpoint({ open: () => { throw Error('must not launch'); } }, { ...request, timeoutMs: 30 }, { parent });
  await assert.rejects(endpoint.completion, /expired/);
  await endpoint.close();
  await endpoint.close();
  assert.deepEqual(readdirSync(parent), ['.owner']);
});
