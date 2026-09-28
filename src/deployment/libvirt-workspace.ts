import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { libvirtOptions } from './libvirt-options.js';
import { durableWrite } from './workspace.js';
import { parseSetup, setupDigest, canonicalJson, type Setup } from '../setup.js';

export interface LibvirtManifest {
  schemaVersion: 1;
  operationId: string;
  directory: string;
  vmName: string;
  filterName: string;
  setup: Setup;
  digest: string;
  binaries: { virsh: string; tofu: string; node: string };
}

export function prepareLibvirtDeployment(root: string, input: unknown, binaries: LibvirtManifest['binaries']): LibvirtManifest {
  const setup = parseSetup(input);
  libvirtOptions(setup);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('libvirt requires a Linux x64 host');
  for (const binary of Object.values(binaries)) if (!isAbsolute(binary)) throw Error('Tool paths must be absolute');
  const parent = realpathSync(root);
  const operationId = randomUUID();
  const directory = join(parent, operationId);
  mkdirSync(directory, { mode: 0o700 });
  const manifest: LibvirtManifest = { schemaVersion: 1, operationId, directory,
    vmName: `runtime-${operationId}`, filterName: `runtime-${operationId}`,
    setup, digest: setupDigest(setup), binaries: { ...binaries } };
  durableWrite(join(directory, 'manifest.json'), manifest);
  mkdirSync(join(directory, 'tofu'), { mode: 0o700 });
  durableWrite(join(directory, 'phase.json'), { phase: 'prepared' });
  return manifest;
}

export function loadLibvirtDeployment(path: string): LibvirtManifest {
  if (lstatSync(path).isSymbolicLink()) throw Error('Manifest must not be a symlink');
  const directory = realpathSync(dirname(path));
  if (resolve(dirname(path)) !== directory || basename(path) !== 'manifest.json') throw Error('Noncanonical manifest path');
  const value = JSON.parse(readFileSync(path, 'utf8')) as LibvirtManifest;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) ||
      value.directory !== directory || basename(directory) !== value.operationId ||
      value.vmName !== `runtime-${value.operationId}` || value.filterName !== value.vmName ||
      value.digest !== setupDigest(value.setup)) throw Error('Deployment ownership mismatch');
  libvirtOptions(value.setup);
  if (!value.binaries || Object.keys(value.binaries).sort().join(',') !== 'node,tofu,virsh' ||
      Object.values(value.binaries).some(binary => typeof binary !== 'string' || !isAbsolute(binary))) throw Error('Invalid tool path');
  const tofu = join(directory, 'tofu');
  if (lstatSync(tofu).isSymbolicLink() || realpathSync(tofu) !== tofu) throw Error('Deployment directory must not be a symlink');
  return value;
}

export function libvirtPhase(manifest: LibvirtManifest): string {
  return JSON.parse(readFileSync(join(manifest.directory, 'phase.json'), 'utf8')).phase;
}

export async function withLibvirtLock<T>(manifestPath: string, action: () => Promise<T>): Promise<T> {
  const m = loadLibvirtDeployment(manifestPath);
  const lock = join(m.directory, 'mutation.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd, canonicalJson({ pid: process.pid, operationId: m.operationId, commandGroups: [] })); fsyncSync(fd);
    return await action();
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function recoverLibvirtLock(manifestPath: string): void {
  const m = loadLibvirtDeployment(manifestPath);
  const lock = join(m.directory, 'mutation.lock');
  let value: { pid: number; operationId: string; commandGroups: number[] };
  try { value = JSON.parse(readFileSync(lock, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (value.operationId !== m.operationId || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !Array.isArray(value.commandGroups) || value.commandGroups.some(group => !Number.isSafeInteger(group) || group < 1)) {
    throw Error('Invalid lock identity');
  }
  for (const group of value.commandGroups) {
    try { process.kill(-group, 0); throw Error('Command group may still be alive'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  try { process.kill(value.pid, 0); throw Error('Lock owner may still be alive'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  unlinkSync(lock);
}
