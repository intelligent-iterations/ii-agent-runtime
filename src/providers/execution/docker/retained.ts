import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest } from '../../../runtime/configuration.js';
import { validateWorkerResources } from '../../../pipeline/worker-resources.js';
import type { WorkerResources } from '../../../pipeline/ports.js';
import type { ProcessRunner } from '../../shared/process.js';

export interface DockerTargetReference {
  schemaVersion: 1;
  backend: 'docker-tofu';
  owner: string;
  daemonId: string;
  implementationDigest: string;
  resources: WorkerResources;
  namespacePolicyImage: string | null;
  workspaceHelperImage: string | null;
}
export interface DockerTargetCheckpoint {
  phase: 'preparing' | 'provisioning' | 'cleaned';
  reference: DockerTargetReference;
}

/** Refuse to reinterpret retained state through another provider implementation. */
export function dockerImplementationDigest(): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const files: Record<string, string> = {};
  for (const name of ['ancillaries', 'provisioning', 'namespace-policy', 'workspace', 'network', 'setup', 'target', 'retained', 'recovery']) {
    files[name] = digest(readFileSync(new URL('./' + name + extension, import.meta.url)));
  }
  for (const name of ['docker-worker', 'docker-workspace']) {
    for (const file of ['main.tf', '.terraform.lock.hcl']) files[name + '/' + file] =
      digest(readFileSync(new URL('../../../../modules/' + name + '/' + file, import.meta.url)));
  }
  return digest(canonicalJson(files));
}

export function privateDirectory(directory: string, owner?: string): void {
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Unsafe retained worker directory');
  if (owner !== undefined) {
    const marker = join(directory, '.owner'), info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 64 ||
        readFileSync(marker, 'utf8') !== owner) throw Error('Retained worker ownership changed');
  }
}

export async function dockerDaemonIdentity(execute: ProcessRunner, options: { directory: string; executablePath: string; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  const timeoutMs = Math.min(10000, options.timeoutMs ?? 10000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('Docker identity deadline expired');
  const output = await execute({ command: 'docker', args: ['info', '--format', '{{json .ID}}'], cwd: options.directory,
    env: { PATH: options.executablePath, HOME: options.directory }, timeoutMs, maxOutputBytes: 4096,
    ...(options.signal ? { signal: options.signal } : {}) });
  const id: unknown = JSON.parse(output);
  if (typeof id !== 'string' || !/^[A-Za-z0-9:-]{8,256}$/.test(id)) throw Error('Docker daemon identity unconfirmed');
  return id;
}

export function validateDockerReference(reference: DockerTargetReference, expected: {
  configurationDigest: string; namespacePolicyImage?: string; workspaceHelperImage?: string;
}): DockerTargetReference {
  const snapshot = JSON.parse(canonicalJson(reference)) as DockerTargetReference;
  if (Object.keys(snapshot).sort().join(',') !== 'backend,daemonId,implementationDigest,namespacePolicyImage,owner,resources,schemaVersion,workspaceHelperImage' ||
      snapshot.schemaVersion !== 1 || snapshot.backend !== 'docker-tofu' || !/^[a-f0-9]{32}$/.test(snapshot.owner) ||
      !/^[A-Za-z0-9:-]{8,256}$/.test(snapshot.daemonId) || snapshot.implementationDigest !== dockerImplementationDigest() ||
      snapshot.namespacePolicyImage !== (expected.namespacePolicyImage ?? null) || snapshot.workspaceHelperImage !== (expected.workspaceHelperImage ?? null) ||
      snapshot.resources.configurationDigest !== expected.configurationDigest) throw Error('Retained worker binding mismatch');
  snapshot.resources = validateWorkerResources(snapshot.resources);
  return snapshot;
}

/** Pins the exact IaC before any retained state is allowed to drive teardown. */
export function verifyRetainedModule(directory: string, moduleName: 'docker-worker' | 'docker-workspace', owner: string): void {
  privateDirectory(directory, owner);
  const module = fileURLToPath(new URL('../../../../modules/' + moduleName + '/', import.meta.url));
  for (const file of ['main.tf', '.terraform.lock.hcl']) {
    const target = join(directory, file), stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > 1048576 ||
        !readFileSync(target).equals(readFileSync(join(module, file)))) throw Error('Retained infrastructure module changed');
  }
}

/** A retained plan may delete only the exact resources still owned by this run. */
export async function attestRetainedResources(options: {
  directory: string; owner: string; module: 'docker-worker' | 'docker-workspace'; configurationDigest?: string;
  run(args: string[]): Promise<string>;
}): Promise<void> {
  const path = join(options.directory, 'terraform.tfstate');
  let state: any;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > 1048576) throw Error('Unsafe retained provider state');
    try { state = JSON.parse(readFileSync(path, 'utf8')); } catch { throw Error('Invalid retained provider state'); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (state.version !== 4 || !Array.isArray(state.resources)) throw Error('Invalid retained provider state');
  const present = new Map<string, Set<string>>();
  const ids = async (kind: string) => {
    if (!present.has(kind)) {
      const args = kind === 'docker_container' ? ['ps', '--all', '--no-trunc', '--format', '{{.ID}}'] :
        kind === 'docker_network' ? ['network', 'ls', '--no-trunc', '--format', '{{.ID}}'] : ['volume', 'ls', '--quiet'];
      present.set(kind, new Set((await options.run(args)).split('\n').map(value => value.trim()).filter(Boolean)));
    }
    return present.get(kind)!;
  };
  const allowed = options.module === 'docker-worker' ? new Set(['docker_image.agent', 'docker_container.agent', 'docker_network.agent', 'docker_volume.workspace']) : new Set(['docker_volume.backing']);
  for (const resource of state.resources) {
    const address = `${resource.type}.${resource.name}`;
    if (!allowed.has(address) || resource.mode !== 'managed' || resource.module !== undefined || !Array.isArray(resource.instances) ||
        !/^provider\["registry\.(?:opentofu\.org|terraform\.io)\/kreuzwerker\/docker"\]$/.test(resource.provider)) throw Error('Retained resource scope changed');
    for (const instance of resource.instances) {
      if (instance.deposed !== undefined) throw Error('Retained resource replacement is unconfirmed');
      if (resource.type === 'docker_image') {
        // The byte-verified module explicitly keeps the shared image cache.
        if (instance.attributes?.keep_locally !== true) throw Error('Shared image retention changed');
        continue;
      }
      const expectedName = resource.type === 'docker_volume' ?
        `agent-runtime-${resource.name === 'backing' ? 'disk' : 'workspace'}-${options.owner}` : `agent-runtime-${options.owner}`;
      const id = instance.attributes?.id;
      if (typeof id !== 'string' || (resource.type === 'docker_volume' ? id !== expectedName : !/^[a-f0-9]{64}$/.test(id))) throw Error('Retained resource identity changed');
      if (!(await ids(resource.type)).has(id)) continue;
      const args = resource.type === 'docker_container' ? ['inspect', id] :
        [resource.type === 'docker_network' ? 'network' : 'volume', 'inspect', id];
      const values = JSON.parse(await options.run(args));
      const value = values[0], labels = resource.type === 'docker_container' ? value?.Config?.Labels : value?.Labels;
      const name = resource.type === 'docker_container' ? value?.Name?.replace(/^\//, '') : value?.Name;
      if (values.length !== 1 || name !== expectedName || labels?.['agent-runtime.owner'] !== options.owner ||
          (resource.type === 'docker_container' && labels?.['agent-runtime.configuration'] !== options.configurationDigest?.slice(7))) throw Error('Retained resource ownership changed');
    }
  }
}


export function readOwnedJson(directory: string, name: string): any {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw Error('Invalid retained filename');
  const path = join(directory, name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > 1048576) throw Error('Unsafe retained metadata');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw Error('Invalid retained metadata'); }
}

/** Durable provider facts, never guest output or provider credentials. */
export function retainOwnedJson(directory: string, name: string, value: unknown): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw Error('Invalid retained filename');
  const text = canonicalJson(value), path = join(directory, name);
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (canonicalJson(readOwnedJson(directory, name)) !== text) throw Error('Retained fact conflict');
    return;
  }
  try { writeFileSync(descriptor, text); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
