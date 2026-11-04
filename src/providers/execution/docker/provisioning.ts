import { reconcileWorkerNetworks } from './ancillaries.js';
import { attestRetainedResources, privateDirectory, readOwnedJson, verifyRetainedModule } from './retained.js';
import { dockerDiskWorkspace } from './workspace.js';
import { dockerNamespacePolicy } from './namespace-policy.js';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, digest } from '../../../runtime/configuration.js';
import { validateWorkerResources } from '../../../pipeline/worker-resources.js';
import type { ExecutionContext, WorkerResources } from '../../../pipeline/ports.js';
import { TargetOperations } from '../shared/operations.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';

/** The workspace must run what builds install; neither mount may honour setuid binaries or device files. */
const mountOptions = (value: unknown, required: string[]) => typeof value === 'string' && required.every(option => value.split(',').includes(option));

export interface ProvisionedWorker { owner: string; containerId: string; networkId: string; directory: string }

export function openTofuWorker(options: { parent: string; owner?: string; resume?: WorkerResources; workspaceHelperImage?: string; namespacePolicyImage?: string; process?: ProcessRunner; executablePath?: string }) {
  const execute = options.process ?? runTrustedProcess;
  const operations = new TargetOperations(execute, 360000);
  const parent = resolve(options.parent);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() || lstatSync(parent).uid !== process.getuid?.()) throw Error('Unsafe provisioning parent');
  if (options.resume && !options.owner) throw Error('Retained worker owner is required');
  const owner = options.owner ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(owner)) throw Error('Invalid worker ownership identity');
  const directory = join(parent, `worker-${owner}`);
  if (options.resume) privateDirectory(directory, owner);
  else {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
  }
  const env = { PATH: options.executablePath ?? '/usr/local/bin:/usr/bin:/bin', HOME: directory,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' };
  const command = (name: string, args: string[], timeoutMs = 120000, cleanup = false) => operations.run({ command: name, args, cwd: directory,
    env, timeoutMs, maxOutputBytes: 1048576 }, cleanup);
  let namespacePolicy: ReturnType<typeof dockerNamespacePolicy> | undefined;
  let diskWorkspace: ReturnType<typeof dockerDiskWorkspace> | undefined;
  let initialized = false;
  let attempted = false;
  let closed = false;
  const ownership = () => {
    if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw Error('Provisioning ownership changed');
  };
  if (options.resume) {
    const config = validateWorkerResources(options.resume);
    operations.start(config.timeoutSeconds);
    attempted = true;
    const complete = ['main.tf', '.terraform.lock.hcl', 'canonical.json', 'runtime.auto.tfvars.json'].every(file => existsSync(join(directory, file)));
    if (!complete && existsSync(join(directory, 'terraform.tfstate'))) throw Error('Retained infrastructure inputs are incomplete');
    if (complete) {
      verifyRetainedModule(directory, 'docker-worker', owner);
      const variables = readOwnedJson(directory, 'runtime.auto.tfvars.json');
      const canonical = readOwnedJson(directory, 'canonical.json');
      const environment = { image: config.image, cpu: config.cpu, memoryMiB: config.memoryMiB, timeoutSeconds: config.timeoutSeconds,
        ...(config.userNamespaces ? { namespaceProfile: `ii-runtime-userns-${owner}` } : {}),
        ...(config.diskGiB !== undefined ? { diskGiB: config.diskGiB, workspaceDevice: canonical.environment?.workspaceDevice } : {}) };
      if (config.diskGiB !== undefined && !/^\/dev\/loop[0-9]+$/.test(environment.workspaceDevice ?? '')) throw Error('Retained disk device changed');
      if (canonicalJson(canonical) !== canonicalJson({ environment }) || variables.owner !== owner ||
          variables.configuration_sha256 !== config.configurationDigest.slice(7) || variables.resources_sha256 !== digest(canonicalJson(canonical)).slice(7) ||
          variables.canonical_configuration_path !== join(directory, 'canonical.json') ||
          Object.keys(variables).sort().join(',') !== 'canonical_configuration_path,configuration_sha256,owner,resources_sha256') throw Error('Retained worker configuration changed');
      initialized = true;
    }
    if (config.userNamespaces) {
      if (!options.namespacePolicyImage) throw Error('Retained namespace helper is required');
      if (existsSync(join(directory, 'namespace-policy.json'))) {
        const policy = readOwnedJson(directory, 'namespace-policy.json');
        if (policy.owner !== owner || policy.profile !== `ii-runtime-userns-${owner}` || policy.image !== options.namespacePolicyImage) throw Error('Retained namespace binding changed');
      }
      namespacePolicy = dockerNamespacePolicy({ owner, image: options.namespacePolicyImage, directory, resume: true,
        environment: env, execute: (request, cleanup) => operations.run(request, cleanup) });
    }
    if (existsSync(join(directory, 'disk'))) {
      if (config.diskGiB === undefined || !options.workspaceHelperImage) throw Error('Retained disk binding is required');
      diskWorkspace = dockerDiskWorkspace({ owner, directory, image: options.workspaceHelperImage, diskGiB: config.diskGiB, resume: true,
        environment: env, execute: (request, cleanup) => operations.run(request, cleanup) });
    }
  }
  return {
    async provision(input: WorkerResources, context?: ExecutionContext): Promise<ProvisionedWorker> {
      if (attempted || closed) throw Error('Provisioning session already used');
      attempted = true;
      ownership();
      const config = validateWorkerResources(input);
      operations.start(config.timeoutSeconds, context);
      if (config.userNamespaces) {
        if (!options.namespacePolicyImage) throw Error('Nested user namespaces require an explicit policy helper image');
        namespacePolicy = dockerNamespacePolicy({ owner, image: options.namespacePolicyImage, directory,
          environment: env, execute: (request, cleanup) => operations.run(request, cleanup) });
        writeFileSync(join(directory, 'namespace-policy.json'), JSON.stringify({ owner,
          profile: namespacePolicy.profile, image: options.namespacePolicyImage }), { flag: 'wx', mode: 0o600 });
        await namespacePolicy.create();
      }
      let workspace: { device: string; sizeBytes: number } | undefined;
      if (config.diskGiB !== undefined) {
        if (!options.workspaceHelperImage) throw Error('Disk workspace requires an explicit helper image');
        diskWorkspace = dockerDiskWorkspace({ owner, directory, image: options.workspaceHelperImage,
          diskGiB: config.diskGiB, environment: env, execute: (request, cleanup) => operations.run(request, cleanup) });
        workspace = await diskWorkspace.create();
      }
      const canonical = canonicalJson({ environment: { image: config.image, cpu: config.cpu, memoryMiB: config.memoryMiB, timeoutSeconds: config.timeoutSeconds, ...(workspace ? { workspaceDevice: workspace.device, diskGiB: config.diskGiB } : {}), ...(namespacePolicy ? { namespaceProfile: namespacePolicy.profile } : {}) } });
      const module = fileURLToPath(new URL('../../../../modules/docker-worker/', import.meta.url));
      for (const name of ['main.tf', '.terraform.lock.hcl']) {
        const path = join(directory, name);
        copyFileSync(join(module, name), path);
        chmodSync(path, 0o600);
      }
      writeFileSync(join(directory, 'canonical.json'), canonical, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(directory, 'runtime.auto.tfvars.json'), JSON.stringify({
        canonical_configuration_path: join(directory, 'canonical.json'), configuration_sha256: config.configurationDigest.slice(7), resources_sha256: digest(canonical).slice(7), owner,
      }), { flag: 'wx', mode: 0o600 });
      await command('tofu', ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color']);
      initialized = true;
      await command('tofu', ['apply', '-auto-approve', '-input=false', '-no-color'], 300000);
      const output = JSON.parse(await command('tofu', ['output', '-json'])) as Record<string, { value: unknown }>;
      const containerId = output.container_id?.value;
      const networkId = output.network_id?.value;
      if (output.owner?.value !== owner || typeof containerId !== 'string' || typeof networkId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(containerId) || !/^[a-f0-9]{64}$/.test(networkId)) throw Error('Provisioning output mismatch');
      const inspections = JSON.parse(await command('docker', ['inspect', containerId])) as Array<Record<string, any>>;
      const inspected = inspections[0];
      if (inspections.length !== 1 || inspected?.Id !== containerId || inspected.Config?.Labels?.['agent-runtime.owner'] !== owner ||
        inspected.Config?.Labels?.['agent-runtime.configuration'] !== config.configurationDigest.slice(7) || inspected.State?.Running !== true ||
        inspected.Config?.User !== '10001:10001' || inspected.HostConfig?.NetworkMode !== 'none' ||
        inspected.HostConfig?.ReadonlyRootfs !== true || inspected.HostConfig?.Privileged !== false ||
        inspected.HostConfig?.Memory !== config.memoryMiB * 1048576 ||
        inspected.HostConfig?.MemorySwap !== config.memoryMiB * 1048576 ||
        inspected.HostConfig?.NanoCpus !== config.cpu * 1000000000 ||
        inspected.HostConfig?.CapDrop?.includes('ALL') !== true ||
        (inspected.HostConfig?.CapAdd?.length ?? 0) !== 0 ||
        JSON.stringify([...(inspected.HostConfig?.SecurityOpt ?? [])].sort()) !== JSON.stringify(['no-new-privileges:true',
          ...(namespacePolicy ? [`apparmor=${namespacePolicy.profile}`, 'seccomp=unconfined'] : [])].sort()) ||
        !Array.isArray(inspected.Mounts) || inspected.Mounts.some((mount: { Type?: string; Destination?: string; Name?: string; RW?: boolean }) =>
          mount.Type !== 'tmpfs' && !(workspace && mount.Type === 'volume' && mount.Destination === '/workspace' &&
            mount.Name === `agent-runtime-workspace-${owner}` && mount.RW === true)) ||
        (workspace ? !inspected.Mounts.some((mount: { Type?: string; Destination?: string }) => mount.Type === 'volume' && mount.Destination === '/workspace') :
          !mountOptions(inspected.HostConfig?.Tmpfs?.['/workspace'], ['rw', 'exec', 'nosuid', 'nodev'])) ||
        !mountOptions(inspected.HostConfig?.Tmpfs?.['/tmp'], ['rw', 'noexec', 'nosuid', 'nodev'])) throw Error('Worker isolation verification failed');
      return { owner, containerId, networkId, directory };
    },
    async close(): Promise<void> {
      if (closed) return;
      await operations.cancel();
      ownership();
      if (initialized) {
        if (options.resume) {
          await attestRetainedResources({ directory, owner, module: 'docker-worker', configurationDigest: options.resume.configurationDigest, run: args => command('docker', args, 120000, true) });
          await command('tofu', ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'], 120000, true);
        }
        await command('tofu', ['destroy', '-auto-approve', '-input=false', '-no-color'], 300000, true);
        const containers = await command('docker', ['ps', '--all', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`, '--filter', `name=^/agent-runtime-${owner}$`], 120000, true);
        const networks = await command('docker', ['network', 'ls', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`], 120000, true);
        if (containers.trim()) throw Error('Worker cleanup unconfirmed');
        await reconcileWorkerNetworks({ directory, owner, run: (name, args) => command(name, args, 120000, true) });
        if (networks.trim() && (await command('docker', ['network', 'ls', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`], 120000, true)).trim()) throw Error('Worker network cleanup unconfirmed');
      }
      if (options.resume && !initialized && (await command('docker', ['ps', '--all', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`, '--filter', `name=^/agent-runtime-${owner}$`], 120000, true)).trim()) throw Error('Retained worker cleanup requires provider state');
      await diskWorkspace?.close();
      await namespacePolicy?.close();
      if (initialized || diskWorkspace || namespacePolicy || options.resume) {
        if ((await command('docker', ['ps', '--all', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`], 120000, true)).trim()) throw Error('Worker helper cleanup unconfirmed');
      }
      ownership();
      rmSync(directory, { recursive: true });
      closed = true;
    },
  };
}
