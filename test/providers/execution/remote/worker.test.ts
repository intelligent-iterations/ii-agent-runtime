import assert from 'node:assert/strict';
import test from 'node:test';
import { connectRemoteWorker } from '../../../../src/providers/execution/remote/worker.js';
import type { RemoteSession } from '../../../../src/providers/execution/remote/channel.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('remote worker commands retain run cancellation even when a command supplies its own signal', async () => {
  const parent = new AbortController(), command = new AbortController();
  const seen: AbortSignal[] = [];
  const remote: RemoteSession = {
    async request<T>(operation: string, _value: unknown, _timeout: number, signal?: AbortSignal): Promise<T> {
      assert.ok(signal); seen.push(signal);
      return (operation === 'provision' ? { workspace: '/workspace' } : '') as T;
    }, async forward() {}, async close() {},
  };
  const worker = await connectRemoteWorker({ remote, resources: { image: 'example/image@sha256:' + 'a'.repeat(64), cpu: 1, memoryMiB: 1024, timeoutSeconds: 60, configurationDigest: 'sha256:' + 'b'.repeat(64) },
    directory: '/unused', owner: 'test', executablePath: '/bin', execute: async () => { throw Error('unused'); }, deadlineMs: Date.now() + 60000, signal: parent.signal });
  await worker.run({ command: 'node', args: ['-v'], timeoutMs: 1000, maxOutputBytes: 1000 });
  await worker.run({ command: 'node', args: ['-v'], timeoutMs: 1000, maxOutputBytes: 1000, signal: command.signal });
  assert.equal(seen.length, 3); assert.equal(seen[1], parent.signal); assert.notEqual(seen[2], command.signal);
  parent.abort(); assert.ok(seen.every(signal => signal.aborted));
});

test('large source transfers respect the OpenShell stdin cap and preserve every byte', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-source-'));
  const source = Buffer.alloc(6 * 1048576 + 57);
  for (let offset = 0; offset < source.length; offset++) source[offset] = offset % 251;
  const chunks: Buffer[] = [];
  const remote: RemoteSession = {
    async request<T>(operation: string, value: any): Promise<T> {
      if (operation === 'provision') return { workspace: '/sandbox' } as T;
      if (operation === 'run' && value.inputBase64 !== undefined) {
        const bytes = Buffer.from(value.inputBase64, 'base64');
        assert.ok(bytes.length <= 4 * 1048576, 'OpenShell rejects piped stdin above 4 MiB');
        assert.equal(value.args.at(-1), chunks.length ? 'a' : 'wx');
        chunks.push(bytes);
      }
      return '' as T;
    }, async forward() {}, async close() {},
  };
  try {
    const worker = await connectRemoteWorker({ remote, resources: { image: 'example/image@sha256:' + 'a'.repeat(64), cpu: 1, memoryMiB: 1024, timeoutSeconds: 60, configurationDigest: 'sha256:' + 'b'.repeat(64) },
      directory, owner: 'test', executablePath: '/bin', deadlineMs: Date.now() + 60000,
      execute: async request => { assert.equal(request.command, 'tar'); writeFileSync(join(directory, 'source.tar'), source); return ''; } });
    await worker.load('/source');
    assert.deepEqual(Buffer.concat(chunks), source);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
