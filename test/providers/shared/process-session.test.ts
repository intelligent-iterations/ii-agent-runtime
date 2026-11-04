import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTrustedProcess } from '../../../src/providers/shared/process-session.js';
import { ProcessFailure } from '../../../src/providers/shared/process.js';

// Real child processes: allow for slow starts on busy hosts. Deadline behavior is tested with explicit short limits.
const base = { command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 15000, maxInputBytes: 4096, maxOutputBytes: 4096 };
const drain = async (output: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of output) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

test('real duplex sessions accept bounded long-run budgets without widening their ceiling', async () => {
  for (const timeoutMs of [5400000, 7200000]) {
    const session = await openTrustedProcess({ ...base, timeoutMs, args: ['-e',
      'process.stdin.on("data",b=>process.stdout.write(b)).resume()'] });
    try {
      const output = drain(session.output);
      await session.write(Buffer.from('bounded'));
      session.end();
      assert.equal(await output, 'bounded');
      assert.deepEqual(await session.completion, { exitCode: 0 });
    } finally { await session.close(); }
  }
  await assert.rejects(openTrustedProcess({ ...base, timeoutMs: 7200001, args: [] }), /Invalid process session limits/);
});

test('duplex transport exchanges messages before stdin closes and reports actual exit', async () => {
  const session = await openTrustedProcess({ ...base, args: ['-e',
    'process.stdout.write("ready\\n");process.stdin.on("data",b=>process.stdout.write("echo:"+b)).on("end",()=>process.exitCode=7)'] });
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const result = (async () => {
    let text = '';
    for await (const chunk of session.output) { text += Buffer.from(chunk).toString(); if (text.includes('ready\n')) ready(); }
    return text;
  })();
  try {
    await readiness;
    await session.write(Buffer.from('hello\n'));
    session.end();
    assert.equal(await result, 'ready\necho:hello\n');
    assert.deepEqual(await session.completion, { exitCode: 7 });
  } finally { await session.close(); }
});

test('duplex transport bounds input and combined output without returning stderr', async () => {
  const input = await openTrustedProcess({ ...base, maxInputBytes: 3, args: ['-e', 'process.stdin.resume()'] });
  await assert.rejects(input.write(Buffer.from('four')), /input limit/);
  await assert.rejects(input.completion, /input limit/);
  await input.close();
  const output = await openTrustedProcess({ ...base, maxOutputBytes: 10, args: ['-e', 'process.stderr.write("synthetic-private-value");setInterval(()=>{},1000)'] });
  const text = drain(output.output).catch(error => String(error));
  await assert.rejects(output.completion, error => {
    assert.ok(error instanceof ProcessFailure);
    assert.equal(error.kind, 'output-limit');
    assert.equal(String(error).includes('synthetic-private-value'), false);
    return true;
  });
  assert.equal((await text).includes('synthetic-private-value'), false);
  await output.close();
});

test('duplex deadlines, cancellation and spawn failure remain typed and bounded', async () => {
  const expired = await openTrustedProcess({ ...base, timeoutMs: 50, args: ['-e', 'setInterval(()=>{},1000)'] });
  await assert.rejects(expired.completion, /deadline/);
  await expired.close();
  const abort = new AbortController();
  const canceled = await openTrustedProcess({ ...base, signal: abort.signal, args: ['-e', 'setInterval(()=>{},1000)'] });
  abort.abort();
  await assert.rejects(canceled.completion, /canceled/);
  await canceled.close();
  await assert.rejects(openTrustedProcess({ ...base, signal: abort.signal, args: [] }), /canceled/);
  await assert.rejects(openTrustedProcess({ ...base, command: '/nonexistent-runtime-test-command', args: ['synthetic-private-argument'] }), error => {
    assert.ok(error instanceof ProcessFailure);
    assert.equal(error.kind, 'spawn');
    assert.equal(String(error).includes('synthetic-private-argument'), false);
    return true;
  });
});

test('duplex launch does not inherit ambient host environment', async () => {
  const key = 'RUNTIME_SESSION_SYNTHETIC_MARKER';
  const previous = process.env[key];
  process.env[key] = 'not-for-child';
  try {
    // Generous deadline: this test is about the environment, and Node can take seconds to start on a busy host.
    const session = await openTrustedProcess({ ...base, timeoutMs: 30000, args: ['-e', `process.stdout.write(String(process.env.${key}))`] });
    assert.equal(await drain(session.output), 'undefined');
    assert.deepEqual(await session.completion, { exitCode: 0 });
    await session.close();
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});
