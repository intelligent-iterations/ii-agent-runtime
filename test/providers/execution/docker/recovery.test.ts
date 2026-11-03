import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dockerTofuTarget } from '../../../../src/providers/execution/docker/target.js';
import { recoverDockerTarget } from '../../../../src/providers/execution/docker/recovery.js';
import { attestRetainedResources, dockerImplementationDigest, verifyRetainedModule, type DockerTargetCheckpoint, type DockerTargetReference } from '../../../../src/providers/execution/docker/retained.js';
import { executionServices } from '../../../../src/providers/services.js';
import { compileConfiguration } from '../../../../src/runtime/configuration.js';
import { workerResources } from '../../../../src/pipeline/worker-resources.js';
import { fixture } from '../../../runtime-fixture.js';

function state(t: TestContext) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'retained-worker-'))), marker = randomUUID();
  writeFileSync(join(parent, '.owner'), marker, { mode: 0o600 });
  t.after(() => { assert.equal(readFileSync(join(parent, '.owner'), 'utf8'), marker); rmSync(parent, { recursive: true }); });
  const resources = workerResources(compileConfiguration(fixture()));
  const reference: DockerTargetReference = { schemaVersion: 1, backend: 'docker-tofu', owner: 'a'.repeat(32), daemonId: 'fixture-daemon-001',
    implementationDigest: dockerImplementationDigest(), resources, namespacePolicyImage: null, workspaceHelperImage: null };
  return { parent, resources, reference, expected: { configurationDigest: resources.configurationDigest }, executablePath: '/trusted/bin' };
}

test('checkpoint refusal precedes acquisition; a recorded run binds daemon, implementation and resource identity', async t => {
  const { parent, resources } = state(t), checkpoints: DockerTargetCheckpoint[] = [];
  let provisioned = false;
  const target = dockerTofuTarget({ parent, executablePath: '/trusted/bin',
    process: async request => { assert.equal(request.args[0], 'info'); return JSON.stringify('fixture-daemon-001'); },
    checkpoint: async checkpoint => { checkpoints.push(checkpoint); if (checkpoint.phase === 'provisioning') throw Error('retention-denied'); },
    services: { ...executionServices, openTofuWorker: options => ({
      async provision() { assert.ok(options.owner); provisioned = true; throw Error('must not acquire'); }, async close() {},
    }) },
  });
  await assert.rejects(target.provision(resources), /retention-denied/); assert.equal(provisioned, false);
  await target.close();
  assert.deepEqual(checkpoints.map(value => value.phase), ['preparing', 'provisioning', 'cleaned']);
  assert.equal(checkpoints[0]!.reference.daemonId, 'fixture-daemon-001');
  assert.deepEqual(checkpoints[0]!.reference.resources, resources);
});

test('another daemon, implementation or configuration cannot receive teardown authority', async t => {
  for (const fault of ['daemon', 'implementation', 'configuration']) {
    const input = state(t); const calls: string[] = [];
    if (fault === 'implementation') input.reference.implementationDigest = 'sha256:' + 'b'.repeat(64);
    if (fault === 'configuration') input.expected.configurationDigest = 'sha256:' + 'b'.repeat(64);
    await assert.rejects(recoverDockerTarget({ ...input, state: { phase: 'provisioning', reference: input.reference },
      process: async request => { calls.push(request.args[0]!); return JSON.stringify('fixture-daemon-002'); } }));
    assert.deepEqual(calls, fault === 'daemon' ? ['info'] : []);
  }
});

test('missing state during acquisition remains unconfirmed instead of becoming an absence receipt', async t => {
  const input = state(t), calls: string[] = [];
  await assert.rejects(recoverDockerTarget({ ...input, state: { phase: 'provisioning', reference: input.reference },
    process: async request => { calls.push(request.args[0]!); return JSON.stringify(input.reference.daemonId); } }), /state is missing/);
  assert.deepEqual(calls, ['info']);
});

test('a pre-acquisition checkpoint can reconcile absence without starting a workload', async t => {
  const input = state(t), calls: string[] = [], phases: string[] = [];
  await recoverDockerTarget({ ...input, state: { phase: 'preparing', reference: input.reference },
    process: async request => { calls.push(request.args[0]!); return request.args[0] === 'info' ? JSON.stringify(input.reference.daemonId) : ''; },
    checkpoint: async checkpoint => { phases.push(checkpoint.phase); } });
  assert.deepEqual(calls, ['info', 'ps', 'network', 'volume']); assert.deepEqual(phases, ['cleaned']);
});

test('retained provider state cannot delete a resource whose actual ownership changed', async t => {
  const input = state(t), calls: string[] = [];
  writeFileSync(join(input.parent, 'terraform.tfstate'), JSON.stringify({ version: 4, resources: [{ mode: 'managed', type: 'docker_container', name: 'agent',
    provider: 'provider["registry.opentofu.org/kreuzwerker/docker"]', instances: [{ attributes: { id: 'c'.repeat(64) } }] }] }), { mode: 0o600 });
  await assert.rejects(attestRetainedResources({ directory: input.parent, owner: input.reference.owner, module: 'docker-worker', configurationDigest: input.resources.configurationDigest,
    run: async args => { calls.push(args[0]!); return args[0] === 'ps' ? 'c'.repeat(64) : JSON.stringify([{ Name: '/agent-runtime-' + input.reference.owner,
      Config: { Labels: { 'agent-runtime.owner': 'another-owner', 'agent-runtime.configuration': input.resources.configurationDigest.slice(7) } } }]); } }), /ownership changed/);
  assert.deepEqual(calls, ['ps', 'inspect']);
});

test('changed module files are preserved without running a provider operation', t => {
  const input = state(t), directory = join(input.parent, 'module'); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, '.owner'), input.reference.owner, { mode: 0o600 });
  for (const name of ['main.tf', '.terraform.lock.hcl']) copyFileSync(new URL('../../../../modules/docker-worker/' + name, import.meta.url), join(directory, name));
  verifyRetainedModule(directory, 'docker-worker', input.reference.owner);
  writeFileSync(join(directory, 'main.tf'), 'unowned replacement');
  assert.throws(() => verifyRetainedModule(directory, 'docker-worker', input.reference.owner), /module changed/);
  assert.equal(readFileSync(join(directory, 'main.tf'), 'utf8'), 'unowned replacement');
});
