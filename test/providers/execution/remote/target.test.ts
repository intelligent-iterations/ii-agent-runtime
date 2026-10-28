import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloudTarget, type CloudHosting } from '../../../../src/providers/execution/remote/target.js';
import { remoteOperations } from '../../../../src/providers/execution/remote/protocol.js';
import type { RemoteSession } from '../../../../src/providers/execution/remote/channel.js';
import type { ExecutionTarget } from '../../../../src/pipeline/ports.js';
import { declaration, infrastructures } from '../../../deployment/fixtures.js';

const resources = { image: 'example/worker@sha256:' + 'a'.repeat(64), cpu: 1, memoryMiB: 1024, timeoutSeconds: 60, configurationDigest: 'sha256:' + 'b'.repeat(64) };
for (const provider of Object.keys(infrastructures)) for (const isolationProvider of ['docker', 'openshell'] as const) test(`${provider}/${isolationProvider}: remote worker lifecycle uses the selected host and preserves cleanup history`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-target-'));
  const calls: string[] = [];
  let directory = '', destroyed = false;
  const config = declaration(provider);
  const remote: RemoteSession = {
    async request<T>(operation: string, value: any): Promise<T> {
      calls.push(operation);
      if (operation === 'provision') { assert.deepEqual(value, resources); return { workspace: '/workspace' } as T; }
      if (operation === 'isolate') return { address: '172.18.0.1' } as T;
      if (operation === 'run') { assert.equal(value.command, 'node'); return 'ran-on-cloud' as T; }
      return undefined as T;
    },
    async forward(address, port) { assert.equal(address, '172.18.0.1'); assert.equal(port, 12345); calls.push('forward'); },
    async close() { calls.push('transport-close'); },
  };
  const target = cloudTarget({ hosting: { provider, infrastructure: config.infrastructure, providerConfiguration: config.providerConfiguration,
    executorImage: 'example/executor@sha256:' + 'c'.repeat(64), ssh: { user: 'operator', identityFile: '/private/key', knownHostsFile: '/private/hosts' } } as CloudHosting,
    isolation: isolationProvider, parent: root, executablePath: '/bin', environment: { AWS_ACCESS_KEY_ID: 'synthetic-provider-only' }, session: options => {
      assert.equal(options.address, '10.0.0.9'); assert.equal(options.isolation, isolationProvider); return remote;
    }, process: async request => {
      directory = request.cwd;
      const args = request.args;
      if (args.includes('plan')) { writeFileSync(join(directory, 'deployment.tfplan'), args.includes('-destroy') ? 'destroy' : 'apply'); }
      if (args.includes('apply') && readFileSync(join(directory, 'deployment.tfplan'), 'utf8') === 'destroy') destroyed = true;
      if (args.includes('show')) return JSON.stringify({ format_version: '1.0', values: { root_module: {} } });
      if (args.includes('output')) return JSON.stringify({ address: { value: '10.0.0.9' } });
      return '{}';
    },
  });
  try {
    const worker = await target.provision(resources);
    const isolation = await worker.isolate();
    assert.equal(isolation.address, '127.0.0.1');
    assert.equal(await isolation.connect(12345), 'http://172.18.0.1:12345');
    assert.equal(await worker.run({ command: 'node', args: ['-v'], timeoutMs: 1000, maxOutputBytes: 1000 }), 'ran-on-cloud');
    await isolation.close(); await target.close(); await target.close();
    assert.equal(destroyed, true);
    assert.deepEqual(calls, ['provision', 'isolate', 'forward', 'connect', 'run', 'seal', 'close', 'transport-close']);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'cleanup.json'), 'utf8')), { hostDestroyed: true, remoteCleanupConfirmed: true });
    assert.doesNotMatch(readFileSync(join(directory, 'main.tf.json'), 'utf8'), /synthetic-provider-only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote operations expose worker primitives and refuse requests to interpret application events', async () => {
  let stopped = 0;
  const target: ExecutionTarget = { async provision() { return { workspace: '/workspace', run: async input => {
    assert.equal(input.input?.toString(), 'stdin'); return 'result';
  }, load: async () => {}, setup: async () => ({ exitCode: 0, seconds: 1, timedOut: false }),
  isolate: async () => ({ address: '172.18.0.1', connect: async () => {}, close: async () => {} }) }; }, async close() { stopped++; } };
  const remote = remoteOperations(target);
  assert.equal((await remote.handle({ id: 1, operation: 'webhook', value: {} })).ok, false);
  assert.equal((await remote.handle({ id: 2, operation: 'provision', value: resources })).ok, true);
  assert.deepEqual(await remote.handle({ id: 3, operation: 'run', value: { command: 'node', args: [], inputBase64: Buffer.from('stdin').toString('base64') } }), { id: 3, ok: true, value: 'result' });
  assert.equal((await remote.handle({ id: 4, operation: 'provision', value: resources })).ok, false);
  await remote.close(); await remote.close(); assert.equal(stopped, 1);
  assert.equal((await remote.handle({ id: 5, operation: 'run', value: {} })).ok, false);
});
