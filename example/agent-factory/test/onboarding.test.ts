import { factoryTartOptions, factoryLibvirtOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { onboardFactory, imagePullArguments, type OnboardingOptions } from '../src/onboarding.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-onboarding-')));
  const calls: string[] = [];
  const options: OnboardingOptions = { directory: join(root, 'factory'), repository: 'org/factory',
    image: 'registry.example/worker@sha256:' + 'a'.repeat(64), codexSecret: 'MODEL_KEY', appConfigPath: join(root, 'private-app.json'),
    host: { tart: '/opt/homebrew/bin/tart', tofu: '/opt/homebrew/bin/tofu', async pullImage(image) { calls.push('pull ' + image); } },
    transport: { async request(method, path) {
      calls.push(method + ' ' + path);
      const ok = (body: unknown) => ({ status: 200, body });
      if (path.includes('/actions/secrets/')) return ok({ name: 'MODEL_KEY' });
      if (path === '/repos/org/factory') return ok({ private: true, default_branch: 'dev' });
      if (path.includes('/git/ref/heads/')) return ok({ object: { sha: 'b'.repeat(40) } });
      if (path.includes('/contents/') || path.includes('/git/ref/tags/')) return { status: 404, body: {} };
      if (method === 'GET' && path.includes('/git/commits/')) return ok({ tree: { sha: 'c'.repeat(40) } });
      if (method === 'POST' && path.endsWith('/git/trees')) return ok({ sha: 'd'.repeat(40) });
      if (method === 'POST' && path.endsWith('/git/commits')) return ok({ sha: 'e'.repeat(40) });
      if (path.includes('/actions/workflows/')) return ok({ id: path.includes('codex') ? 12 : 13, state: 'active' });
      if (method !== 'GET') return ok({});
      throw Error('Unexpected API request');
    } } };
  return { root, options, calls, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('factory onboarding downloads the image and installs workflows without asking for a target repository', async () => {
  const f = fixture();
  try {
    assert.equal((await onboardFactory(f.options)).existing, false);
    const installation = JSON.parse(readFileSync(join(f.options.directory, 'installation.json'), 'utf8'));
    assert.equal(installation.workerWorkflow.id, 12);
    assert.deepEqual(installation.runner, {groupId:1,workFolder:'_work'});
    assert.deepEqual(installation.roles.code.setup.deployment.options,factoryTartOptions());
    assert.equal(installation.verificationWorkflow.id, 13);
    assert.equal(installation.roles.code.credentialKey, 'MODEL_KEY');
    assert.equal(installation.source, undefined);
    assert.equal(installation.agentsSource, './agents.yaml');
    assert.deepEqual(parse(readFileSync(join(f.options.directory, 'agents.yaml'), 'utf8')).agents, []);
    assert.ok(f.calls.findIndex(c => c.startsWith('pull ')) < f.calls.findIndex(c => c.startsWith('POST ')));
    const calls = f.calls.length;
    assert.equal((await onboardFactory(f.options)).existing, true);
    assert.deepEqual(f.calls.slice(calls), ['GET /repos/org/factory/actions/secrets/MODEL_KEY', 'pull ' + f.options.image]);
    await assert.rejects(onboardFactory({ ...f.options, repository: 'org/another' }), /differs/);
  } finally { f.close(); }
});

test('Linux onboarding pins libvirt and preserves the App configuration on rerun', async () => {
  const f = fixture();
  try {
    f.options.image = `factory-worker.qcow2@sha256:${'a'.repeat(64)}`;
    f.options.host = { virsh: '/usr/bin/virsh', tofu: '/usr/bin/tofu',
      async pullImage(image) { f.calls.push('prepared ' + image); } };
    await onboardFactory(f.options);
    const installation = JSON.parse(readFileSync(join(f.options.directory, 'installation.json'), 'utf8'));
    assert.equal(installation.appConfigPath, f.options.appConfigPath);
    assert.deepEqual(installation.binaries, { virsh: '/usr/bin/virsh', tofu: '/usr/bin/tofu' });
    assert.equal(installation.roles.code.setup.deployment.provider, 'libvirt');
    assert.deepEqual(installation.roles.code.setup.deployment.options, factoryLibvirtOptions());
    assert.equal((await onboardFactory(f.options)).existing, true);
    await assert.rejects(onboardFactory({ ...f.options, host: {
      tart: '/opt/homebrew/bin/tart', tofu: '/usr/bin/tofu', async pullImage() {} },
    }), /provider settings/);
  } finally { f.close(); }
});

test('a failed image download does not publish workflows or claim an installed factory', async () => {
  const f = fixture();
  try {
    f.options.host.pullImage = async () => { throw Error('Download failed'); };
    await assert.rejects(onboardFactory(f.options), /Download failed/);
    assert.equal(f.calls.some(c => c.startsWith('POST ') || c.startsWith('PATCH ')), false);
    assert.equal(existsSync(join(f.options.directory, 'installation.json')), false);
  } finally { f.close(); }
});


test('rerunning setup checks dependencies and preserves edited agent configuration', async () => {
  const f = fixture();
  try {
    await onboardFactory(f.options);
    const agents = join(f.options.directory, 'agents.yaml');
    const edited = '# operator configuration\nagents: []\n';
    writeFileSync(agents, edited);
    const installation = readFileSync(join(f.options.directory, 'installation.json'), 'utf8');
    f.calls.length = 0;
    f.options.host.pullImage = async () => { throw Error('Registry unavailable'); };
    await assert.rejects(onboardFactory(f.options), /Registry unavailable/);
    assert.equal(readFileSync(agents, 'utf8'), edited);
    assert.equal(readFileSync(join(f.options.directory, 'installation.json'), 'utf8'), installation);
    assert.equal(f.calls.some(c => c.startsWith('POST ') || c.startsWith('PATCH ')), false);
    f.options.transport.request = async () => ({ status: 404, body: {} });
    await assert.rejects(onboardFactory(f.options), /Add the MODEL_KEY Actions secret/);
    rmSync(join(f.options.directory, 'controller.mjs'));
    await assert.rejects(onboardFactory(f.options), /missing controller.mjs/);
  } finally { f.close(); }
});


test('image pulls permit HTTP only on exact loopback registry names', () => {
  for (const host of ['localhost', 'localhost:15055', '127.0.0.1:15055']) {
    const image = host + '/factory/worker@sha256:' + 'a'.repeat(64);
    assert.deepEqual(imagePullArguments(image), ['pull', '--insecure', image]);
  }
  for (const host of ['registry.example', 'localhost.example', '127.0.0.1.example', '192.168.1.1', 'localhost@registry.example']) {
    const image = host + '/factory/worker@sha256:' + 'a'.repeat(64);
    assert.deepEqual(imagePullArguments(image), ['pull', image]);
  }
});

test('older installation policy is never silently replaced during wizard rerun', async () => {
  const f=fixture();try {
    await onboardFactory(f.options);
    const path=join(f.options.directory,'installation.json');const before=JSON.parse(readFileSync(path,'utf8'));
    delete before.roles.code.setup.deployment.options;writeFileSync(path,JSON.stringify(before));
    const bytes=readFileSync(path);const calls=f.calls.length;
    await assert.rejects(onboardFactory(f.options),/original checkout/);
    assert.deepEqual(readFileSync(path),bytes);assert.equal(f.calls.length,calls);
  } finally {f.close();}
});
