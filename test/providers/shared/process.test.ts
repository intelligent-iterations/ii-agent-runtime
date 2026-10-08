import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { ProcessFailure, runTrustedProcess, type ProcessFailureKind, type ProcessRequest } from '../../../src/providers/shared/process.js';

test('process failures distinguish cancellation, deadlines, output exhaustion and command failure without child text', async () => {
  const base = { command: process.execPath, cwd: tmpdir(), env: {}, timeoutMs: 3000, maxOutputBytes: 128 };
  const canceled = new AbortController(); canceled.abort();
  for (const [kind, request] of [
    ['canceled', { ...base, signal: canceled.signal, args: ['-e', 'process.exit(0)'] }],
    ['deadline', { ...base, timeoutMs: 50, args: ['-e', 'setInterval(()=>{},1000)'] }],
    ['output-limit', { ...base, args: ['-e', 'process.stdout.write("x".repeat(1024))'] }],
    ['exit', { ...base, args: ['-e', 'process.stderr.write("synthetic-secret");process.exit(1)'] }],
    ['spawn', { ...base, command: '/nonexistent-ii-runtime-command', args: [] }],
  ] as Array<[ProcessFailureKind, ProcessRequest]>) {
    await assert.rejects(runTrustedProcess(request), error => {
      assert.ok(error instanceof ProcessFailure);
      assert.equal(error.kind, kind);
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
  }
});

test('cancellation terminates an already running process', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    await assert.rejects(runTrustedProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: tmpdir(), env: {}, timeoutMs: 3000, maxOutputBytes: 128, signal: abort.signal }),
    error => error instanceof ProcessFailure && error.kind === 'canceled');
  } finally { clearTimeout(timer); }
});
