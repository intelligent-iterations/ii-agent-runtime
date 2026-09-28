import { testTartOptions } from './fixtures/provider-options.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, symlinkSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTartDeployment, loadDeployment, recoverDeploymentLock, withDeploymentLock } from '../src/deployment/workspace.js';
import { createTartVM, tartCloneArguments, tartNetworkArguments, inspectTartDeployment, startTartVM, removeTartVM } from '../src/deployment/tart.js';
import { deployTart, destroyTart } from '../src/deployment/opentofu.js';
import type { CommandExecutor } from '../src/deployment/commands.js';
import type { CheckContext, Setup } from '../src/index.js';

const setup = (): Setup => ({ schemaVersion: 1, id: 'sample', revision: '1', harness: { name: 'example', version: '1' },
  deployment: { provider: 'tart', options: testTartOptions(), image: `registry.example/linux@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-test-'));
  const manifest = prepareTartDeployment(root, setup(), { tart: '/fake/tart', tofu: '/fake/tofu', node: process.execPath });
  const path = join(manifest.directory, 'manifest.json');
  let present = false, running = false, cpu = 2, memory = 2048;
  let fail: string | undefined;
  const calls: string[][] = [];
  const driver: CommandExecutor = {
    async run(binary, args, options) {
      calls.push([binary, ...args]);
      if (binary === '/fake/tofu') return '';
      assert.equal(options.env.TART_HOME, join(manifest.directory, 'tart'));
      assert.equal(options.env.TART_NO_AUTO_PRUNE, '1');
      switch (args[0]) {
        case 'list': if (fail === 'list') throw Error('unavailable'); return JSON.stringify(present ? [{ Name: manifest.vmName, Source: 'local', Running: running }] : []);
        case 'get': if (fail === 'get') throw Error('corrupt'); return JSON.stringify({ CPU: cpu, Memory: memory, Running: running, OS: 'linux' });
        case 'clone': present = true; if (fail === 'clone') throw Error('response lost'); return '';
        case 'set': assert.ok(args.includes('--random-mac'), 'Clones need a fresh MAC across independent Tart homes'); cpu = fail === 'shape' ? 64 : Number(args[3]); memory = Number(args[5]); return '';
        case 'stop': if (fail === 'stop') throw Error('stop failed'); running = false; return '';
        case 'delete': if (fail !== 'delete') present = false; return '';
      }
      throw Error('Unexpected command');
    },
    async start(_, args, options) {
      calls.push(args);
      assert.ok(args.includes('--net-softnet')); assert.ok(args.some(arg => arg.startsWith('--net-softnet-block=') && arg.includes('192.168.0.0/16'))); assert.ok(args.includes('--no-clipboard'));
      assert.ok(!args.some(a => a === '--dir' || a === '--disk'));
      assert.equal(options.env.TART_HOME, join(manifest.directory, 'tart')); running = true;
    },
  };
  return { root, manifest, path, driver, calls, fault(value: string) { fail = value; }, dispose() { rmSync(root, { recursive: true }); } };
}
const authorized: CheckContext = { subject: 'trusted', authorize: async () => ({ status: 'verified', evidenceId: 'auth' }), inspectSecret: async () => ({ status: 'verified', evidenceId: 'metadata' }) };

test('operation input is immutable and distinct operations cannot target the same state/home', () => {
  const f = fixture();
  try {
    const second = prepareTartDeployment(f.root, setup(), f.manifest.binaries);
    assert.notEqual(second.directory, f.manifest.directory); assert.notEqual(second.vmName, f.manifest.vmName);
    assert.equal(second.digest, f.manifest.digest);
    f.manifest.setup.deployment.cpu = 64;
    assert.equal(loadDeployment(f.path).setup.deployment.cpu, 2);
  } finally { f.dispose(); }
});

test('create/read/start/remove verifies shape and supports idempotent deletion', async () => {
  const f = fixture(); try {
    const result = await createTartVM(f.path, f.driver);
    assert.equal(result.cpu, 2); assert.equal(result.running, false);
    await startTartVM(f.path, f.driver);
    assert.equal((await inspectTartDeployment(f.path, f.driver)).running, true);
    assert.equal((await removeTartVM(f.path, f.driver)).present, false);
    assert.equal((await removeTartVM(f.path, f.driver)).present, false);
    assert.equal(f.calls.filter(c => c.includes('delete')).length, 1);
  } finally { f.dispose(); }
});

test('lost clone response blocks duplicate creation and permits owned partial cleanup', async () => {
  const f = fixture(); try {
    f.fault('clone'); await assert.rejects(createTartVM(f.path, f.driver), /response lost/);
    await assert.rejects(createTartVM(f.path, f.driver), /already attempted/);
    assert.equal(f.calls.filter(c => c.includes('clone')).length, 1);
    assert.equal((await removeTartVM(f.path, f.driver)).present, false);
  } finally { f.dispose(); }
});

test('bad shape refuses startup and cleanup does not require a readable guest configuration', async () => {
  const f = fixture(); try {
    f.fault('shape'); await assert.rejects(createTartVM(f.path, f.driver), /configuration mismatch/);
    await assert.rejects(startTartVM(f.path, f.driver), /not ready/);
    f.fault('get'); assert.equal((await removeTartVM(f.path, f.driver)).present, false);
  } finally { f.dispose(); }
});

test('stop failure and still-present deletion do not report successful cleanup', async () => {
  const f = fixture(); try {
    await createTartVM(f.path, f.driver); await startTartVM(f.path, f.driver);
    f.fault('stop'); await assert.rejects(removeTartVM(f.path, f.driver), /stop failed/);
    assert.equal(f.calls.filter(c => c.includes('delete')).length, 0);
    f.fault('delete'); await assert.rejects(removeTartVM(f.path, f.driver), /not confirmed/);
    assert.notEqual(JSON.parse(readFileSync(join(f.manifest.directory, 'phase.json'), 'utf8')).phase, 'removed');
  } finally { f.dispose(); }
});

test('unavailable inventory is unknown, never absence', async () => {
  const f = fixture(); try {
    f.fault('list'); await assert.rejects(removeTartVM(f.path, f.driver), /unavailable/);
    assert.equal(f.calls.filter(c => c.includes('delete')).length, 0);
  } finally { f.dispose(); }
});

test('symlink replacement of an owned home is rejected before provider calls', async () => {
  const f = fixture(); try {
    const path = join(f.manifest.directory, 'tart'); renameSync(path, path + '-original'); symlinkSync(path + '-original', path);
    await assert.rejects(removeTartVM(f.path, f.driver), /symlink/); assert.equal(f.calls.length, 0);
  } finally { f.dispose(); }
});

test('concurrent mutation is rejected and live process lock cannot be recovered', async () => {
  const f = fixture(); try {
    await withDeploymentLock(f.path, async () => {
      await assert.rejects(createTartVM(f.path, f.driver), /EEXIST/);
      await assert.rejects(recoverDeploymentLock(f.path), /still be alive/);
      assert.equal(f.calls.length, 0);
    });
    await createTartVM(f.path, f.driver);
  } finally { f.dispose(); }
});

test('deployment authorization precedes all provider calls and destroy reconciles skipped hooks', async () => {
  const f = fixture(); try {
    await assert.rejects(deployTart(f.path, { ...authorized, authorize: async () => ({ status: 'unknown', evidenceId: 'unavailable' }) }, f.driver));
    assert.equal(f.calls.length, 0);
    await createTartVM(f.path, f.driver);
    assert.equal((await destroyTart(f.path, f.driver)).present, false);
    assert.ok(f.calls.some(c => c.includes('destroy'))); assert.ok(f.calls.some(c => c.includes('delete')));
  } finally { f.dispose(); }
});

test('a killed lock owner requires explicit recovery before mutations resume', async () => {
  const f = fixture();
  const moduleUrl = new URL('../src/deployment/workspace.ts', import.meta.url).href;
  const source = `import { withDeploymentLock } from ${JSON.stringify(moduleUrl)}; await withDeploymentLock(${JSON.stringify(f.path)}, async () => { process.stdout.write('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore','pipe','pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('Lock process exited before acquiring lock'); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await assert.rejects(createTartVM(f.path, f.driver), /EEXIST/);
    await recoverDeploymentLock(f.path);
    assert.equal((await createTartVM(f.path, f.driver)).present, true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); f.dispose(); }
});

test('HTTP image transport is limited to explicit loopback registry authorities', () => {
  for (const host of ['127.0.0.1:15055','localhost:15055']) assert.ok(tartCloneArguments(`${host}/image@sha256:${'a'.repeat(64)}`,'vm').includes('--insecure'));
  for (const host of ['localhost.example','127.0.0.1.example','192.168.1.1:5000','registry.example']) assert.ok(!tartCloneArguments(`${host}/image@sha256:${'a'.repeat(64)}`,'vm').includes('--insecure'));
});

test('killed owner stops its active command group before the lock can be recovered', async () => {
  const f = fixture();
  const workspace = new URL('../src/deployment/workspace.ts', import.meta.url).href;
  const commands = new URL('../src/deployment/commands.ts', import.meta.url).href;
  const marker = join(f.manifest.directory, 'command-started');
  const source = `import {withDeploymentLock} from ${JSON.stringify(workspace)};
    import {commands,toolEnvironment} from ${JSON.stringify(commands)};
    await withDeploymentLock(${JSON.stringify(f.path)},()=>commands.run(process.execPath,['-e',
      ${JSON.stringify("require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)")},${JSON.stringify(marker)}],
      {cwd:${JSON.stringify(f.manifest.directory)},env:toolEnvironment(),timeoutMs:60000}));`;
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: 'ignore' });
  let commandPid: number | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!commandPid) {
      try { commandPid = Number(readFileSync(marker, 'utf8')); } catch {}
      if (Date.now() > deadline) throw Error('Command never started');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const lock = JSON.parse(readFileSync(join(f.manifest.directory, 'mutation.lock'), 'utf8'));
    assert.equal(lock.commandGroups.length, 1);
    await assert.rejects(recoverDeploymentLock(f.path), /still be alive/);
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    const recoveryDeadline = Date.now() + 5000;
    while (true) {
      try { await recoverDeploymentLock(f.path); break; }
      catch (error) {
        if (Date.now() > recoveryDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    assert.throws(() => process.kill(commandPid!, 0), { code: 'ESRCH' });
    await recoverDeploymentLock(f.path); // Already recovered is safe to repeat.
    assert.equal((await createTartVM(f.path, f.driver)).present, true);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited; }
    if (commandPid) { try { process.kill(commandPid, 'SIGKILL'); } catch {} }
    f.dispose();
  }
});


test('legacy lock without command ownership evidence cannot be automatically recovered', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.manifest.directory, 'mutation.lock'), JSON.stringify({ pid: process.pid, operationId: f.manifest.operationId }));
    await assert.rejects(recoverDeploymentLock(f.path), /Invalid command group identity/);
  } finally { f.dispose(); }
});


test('network policy blocks private gateways and current host IPv4 endpoints without granting exceptions', () => {
  const args = tartNetworkArguments(testTartOptions().network, ['192.168.2.135', '8.8.4.4', '192.168.2.135']);
  assert.deepEqual(args, ['--net-softnet', '--net-softnet-block=0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,192.168.2.135/32,8.8.4.4/32']);
  assert.throws(() => tartNetworkArguments(testTartOptions().network, ['invalid']), /Invalid host IPv4/);
});


test('confirmed VM deletion removes only its image cache and preserves retained state', async () => {
  const f = fixture();
  try {
    const cache = join(f.manifest.directory, 'tart', 'cache'); mkdirSync(cache);
    writeFileSync(join(cache, 'image'), 'large disposable image');
    const retained = join(f.manifest.directory, 'retained-result'); writeFileSync(retained, 'evidence');
    const foreign = join(f.root, 'other-cache'); mkdirSync(foreign); writeFileSync(join(foreign, 'image'), 'other image');
    symlinkSync(foreign, join(cache, 'nested-link'));
    await createTartVM(f.path, f.driver); await removeTartVM(f.path, f.driver);
    assert.equal(existsSync(cache), false); assert.equal(readFileSync(retained, 'utf8'), 'evidence');
    assert.equal(readFileSync(join(foreign, 'image'), 'utf8'), 'other image');
    assert.equal(loadDeployment(f.path).operationId, f.manifest.operationId);
    await removeTartVM(f.path, f.driver);
  } finally { f.dispose(); }
});

test('unconfirmed VM deletion preserves its cache for recovery', async () => {
  const f = fixture();
  try {
    const cache = join(f.manifest.directory, 'tart', 'cache'); mkdirSync(cache); writeFileSync(join(cache, 'image'), 'recoverable');
    await createTartVM(f.path, f.driver); f.fault('delete');
    await assert.rejects(removeTartVM(f.path, f.driver), /not confirmed/);
    assert.equal(readFileSync(join(cache, 'image'), 'utf8'), 'recoverable');
    f.fault(''); await removeTartVM(f.path, f.driver); assert.equal(existsSync(cache), false);
  } finally { f.dispose(); }
});

test('redirected cache is rejected without touching the target or claiming completed removal', async () => {
  const f = fixture();
  try {
    const foreign = join(f.root, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'image'), 'preserve');
    symlinkSync(foreign, join(f.manifest.directory, 'tart', 'cache'));
    await createTartVM(f.path, f.driver);
    await assert.rejects(removeTartVM(f.path, f.driver), /Unsafe deployment image cache/);
    assert.equal(readFileSync(join(foreign, 'image'), 'utf8'), 'preserve');
    assert.notEqual(JSON.parse(readFileSync(join(f.manifest.directory, 'phase.json'), 'utf8')).phase, 'removed');
  } finally { f.dispose(); }
});
