import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLibvirtDeployment, deployLibvirt, startLibvirtVM, inspectLibvirtDeployment,
  recoverLibvirtLock, destroyLibvirt, removeLibvirtVM } from '@intelligent-iterations/ii-agent-runtime';
import { factoryLibvirtOptions } from '../src/defaults.js';

const check = { subject: 'linux-crash-probe', authorize: async () => ({ status: 'verified' as const, evidenceId: 'operator-test' }),
  inspectSecret: async () => { throw Error('Probe has no secrets'); } };
if (process.argv[2] === '--child') {
  const path = process.argv[3]; const ready = process.argv[4];
  if (!path || !ready) throw Error('Missing child state');
  await deployLibvirt(path, check);
  await startLibvirtVM(path);
  writeFileSync(ready, 'running', { flag: 'wx', mode: 0o600 });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Run this check on a Linux x64 KVM host');
  const image = process.argv[2]; if (!image) throw Error('Usage: npm run verify:linux-crash -- VOLUME@sha256:DIGEST');
  const binary = (name: string) => realpathSync(execFileSync('which', [name], { encoding: 'utf8' }).trim());
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-linux-crash-')));
  const manifest = prepareLibvirtDeployment(root, { schemaVersion: 1, id: 'crash-check', revision: '1',
    harness: { name: 'verification', version: '1' },
    deployment: { provider: 'libvirt', options: factoryLibvirtOptions(), image, cpu: 2, memoryMiB: 2048 },
    secrets: [], capture: { paths: [] } }, { virsh: binary('virsh'), tofu: binary('tofu'), node: process.execPath });
  const path = join(manifest.directory, 'manifest.json'); const ready = join(manifest.directory, 'child.ready');
  let child: ReturnType<typeof spawn> | undefined;
  let cleanupConfirmed = false;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', process.argv[1]!, '--child', path, ready],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + 240_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw Error('VM did not reach running state before crash check');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(readFileSync(ready, 'utf8'), 'running');
    assert.equal((await inspectLibvirtDeployment(path)).running, true);
    const exit = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exit;
    recoverLibvirtLock(path);
    try { await destroyLibvirt(path); }
    catch (error) { await removeLibvirtVM(path); throw error; }
    assert.equal((await inspectLibvirtDeployment(path)).present, false);
    cleanupConfirmed = true;
    process.stdout.write(JSON.stringify({ passed: true, vm: manifest.vmName, cleanupConfirmed }) + '\n');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!cleanupConfirmed) process.stderr.write(`Cleanup unconfirmed; retained state: ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
}
