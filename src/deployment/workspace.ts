import { tartOptions } from './tart-options.js';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, parseSetup, setupDigest, type Setup } from '../setup.js';

export interface DeploymentManifest {
  schemaVersion: 1;
  operationId: string;
  directory: string;
  vmName: string;
  setup: Setup;
  digest: string;
  binaries: { tart: string; tofu: string; node: string };
}
export function durableWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, canonicalJson(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function prepareTartDeployment(root: string, input: unknown, binaries: DeploymentManifest['binaries']): DeploymentManifest {
  const setup = parseSetup(input);
  if (setup.deployment.provider !== 'tart') throw new Error('Expected Tart setup');
  tartOptions(setup);
  for (const binary of Object.values(binaries)) if (!isAbsolute(binary)) throw new Error('Tool paths must be absolute');
  const parent = realpathSync(root);
  const operationId = randomUUID();
  const directory = join(parent, operationId);
  mkdirSync(directory, { mode: 0o700 });
  const manifest: DeploymentManifest = { schemaVersion: 1, operationId, directory, vmName: `runtime-${operationId}`,
    setup, digest: setupDigest(setup), binaries: { ...binaries } };
  durableWrite(join(directory, 'manifest.json'), manifest);
  mkdirSync(join(directory, 'tart'), { mode: 0o700 });
  mkdirSync(join(directory, 'tofu'), { mode: 0o700 });
  durableWrite(join(directory, 'phase.json'), { phase: 'prepared' });
  return manifest;
}
/** The trusted operator owns this directory; never load records from a guest-writable location. */
export function loadDeployment(path: string): DeploymentManifest {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Manifest must not be a symlink');
  const directory = realpathSync(dirname(path));
  if (resolve(dirname(path)) !== directory || basename(path) !== 'manifest.json') throw new Error('Noncanonical manifest path');
  const value = JSON.parse(readFileSync(path, 'utf8')) as DeploymentManifest;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) ||
      value.directory !== directory || basename(directory) !== value.operationId || value.vmName !== `runtime-${value.operationId}` ||
      value.digest !== setupDigest(value.setup) || value.setup.deployment.provider !== 'tart') throw new Error('Deployment ownership mismatch');
  tartOptions(value.setup);
  for (const binary of Object.values(value.binaries)) if (typeof binary !== 'string' || !isAbsolute(binary)) throw new Error('Invalid tool path');
  for (const subdirectory of ['tart','tofu']) {
    const child = join(directory, subdirectory);
    if (lstatSync(child).isSymbolicLink() || realpathSync(child) !== child) throw new Error('Deployment directory must not be a symlink');
  }
  return value;
}
export function phase(manifest: DeploymentManifest): string {
  return JSON.parse(readFileSync(join(manifest.directory, 'phase.json'), 'utf8')).phase;
}

/** A crash leaves a lock for explicit recovery instead of admitting conflicting mutations. */
export async function withDeploymentLock<T>(manifestPath: string, action: () => Promise<T>): Promise<T> {
  const m = loadDeployment(manifestPath);
  const lock = join(m.directory, 'mutation.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd, canonicalJson({ pid: process.pid, operationId: m.operationId, commandGroups: [] })); fsyncSync(fd);
    return await action();
  } finally {
    closeSync(fd);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(lock);
  }
}
/** Internal command launch gate: record the group before it can execute provider code. */
export function recordDeploymentCommand(directory: string, group: number): void {
  const path = join(directory, 'mutation.lock');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (value.pid !== process.pid) throw new Error('Command does not own deployment lock');
  const groups: number[] = value.commandGroups ?? [];
  durableWrite(path, { ...value, commandGroups: [...groups, group] });
}
export async function recoverDeploymentLock(manifestPath: string): Promise<void> {
  const m = loadDeployment(manifestPath);
  const lock = join(m.directory, 'mutation.lock');
  let value;
  try { value = JSON.parse(readFileSync(lock, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const groups: unknown = value.commandGroups;
  if (!Array.isArray(groups) || groups.some(group => !Number.isSafeInteger(group) || group < 1)) throw new Error('Invalid command group identity');
  for (const group of groups) {
    try { process.kill(-group, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error('Command group may still be alive; do not remove the lock');
  }
  if (value.operationId !== m.operationId || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('Invalid lock identity');
  try { process.kill(value.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      const { unlinkSync } = await import('node:fs'); unlinkSync(lock); return;
    }
  }
  throw new Error('Lock owner may still be alive; do not remove the lock');
}
