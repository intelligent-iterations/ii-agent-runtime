import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openTofuWorker } from '../src/providers/docker-opentofu.js';
import { runTrustedProcess, type ProcessRequest } from '../src/providers/process.js';
import { compileConfiguration } from '../src/runtime/configuration.js';
import { fixture } from './runtime-fixture.js';

test('provisioning keeps secrets out of state inputs, verifies isolation and destroys partial applies', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-tofu-test-')));
  const marker = randomUUID();
  writeFileSync(join(root, '.owner'), marker, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(root, '.owner'), 'utf8'), marker); rmSync(root, { recursive: true }); });
  for (const fault of ['none', 'apply', 'isolation', 'noexec', 'cleanup']) {
    const calls: ProcessRequest[] = [];
    const config = fixture();
    const worker = openTofuWorker({ parent: root, process: async request => {
      calls.push(request);
      // Provisioning sees no credential at all: only its own settings, a path and a home directory.
      assert.deepEqual(Object.keys(request.env).sort(), ['CHECKPOINT_DISABLE', 'HOME', 'PATH', 'TF_INPUT', 'TF_IN_AUTOMATION']);
      const owner = readFileSync(join(request.cwd, '.owner'), 'utf8');
      if (request.args[0] === 'apply' && fault === 'apply') throw Error('Partial apply');
      if (request.args[0] === 'output') return JSON.stringify({ container_id: { value: 'c'.repeat(64) }, network_id: { value: 'd'.repeat(64) }, owner: { value: owner } });
      if (request.args[0] === 'inspect') return JSON.stringify([{
        Id: 'c'.repeat(64), State: { Running: true }, Config: { User: '10001:10001', Labels: {
          'agent-runtime.owner': owner, 'agent-runtime.configuration': compileConfiguration(config).artifactDigest.slice(7) } },
        HostConfig: { NetworkMode: fault === 'isolation' ? 'host' : 'none', ReadonlyRootfs: true, Privileged: false,
          Memory: config.environment.memoryMiB * 1048576, MemorySwap: config.environment.memoryMiB * 1048576,
          NanoCpus: config.environment.cpu * 1000000000, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001',
            '/workspace': `rw,${fault === 'noexec' ? 'noexec' : 'exec'},nosuid,nodev,size=${config.environment.memoryMiB}m,uid=10001,gid=10001` } }, Mounts: [],
      }]);
      if (request.args[0] === 'ps' && fault === 'cleanup') return 'remaining-container';
      return '';
    } });
    if (fault === 'apply' || fault === 'isolation' || fault === 'noexec') await assert.rejects(worker.provision(compileConfiguration(config)));
    else await worker.provision(compileConfiguration(config));
    const directory = calls[0]!.cwd;
    assert.equal(readFileSync(join(directory, 'canonical.json'), 'utf8'), compileConfiguration(config).canonical);
    const variables = JSON.parse(readFileSync(join(directory, 'runtime.auto.tfvars.json'), 'utf8'));
    assert.deepEqual(Object.keys(variables).sort(), ['canonical_configuration_path', 'configuration_sha256', 'owner']);
    if (fault === 'cleanup') await assert.rejects(worker.close(), /cleanup unconfirmed/);
    else await worker.close();
    assert.ok(calls.some(call => call.args[0] === 'destroy'));
    assert.equal(readdirSync(root).includes(directory.split('/').at(-1)!), fault === 'cleanup');
  }
});

test('process boundary bounds output and runtime without echoing child secrets', async () => {
  const base = { command: process.execPath, cwd: process.cwd(), env: {}, timeoutMs: 2000, maxOutputBytes: 1024 };
  assert.equal(await runTrustedProcess({ ...base, args: ['-e', 'process.stdout.write("ok")'] }), 'ok');
  await assert.rejects(runTrustedProcess({ ...base, args: ['-e', 'process.stderr.write("synthetic-secret");process.exit(1)'] }), error => {
    assert.equal(String(error).includes('synthetic-secret'), false); return true;
  });
  await assert.rejects(runTrustedProcess({ ...base, args: ['-e', 'process.stdout.write("a".repeat(4096))'] }), /output limit/);
  await assert.rejects(runTrustedProcess({ ...base, timeoutMs: 50, args: ['-e', 'setInterval(()=>{},1000)'] }), /deadline/);
});
