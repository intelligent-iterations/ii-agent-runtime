import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileConfiguration, type CompiledConfiguration } from '../runtime/configuration.js';
import { runTrustedProcess, type ProcessRunner } from './process.js';

/** The workspace must run what builds install; neither mount may honour setuid binaries or device files. */
const mountOptions = (value: unknown, required: string[]) => typeof value === 'string' && required.every(option => value.split(',').includes(option));

export interface ProvisionedWorker { owner: string; containerId: string; networkId: string; directory: string }

export function openTofuWorker(options: { parent: string; process?: ProcessRunner; executablePath?: string }) {
  const execute = options.process ?? runTrustedProcess;
  const parent = resolve(options.parent);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() || lstatSync(parent).uid !== process.getuid?.()) throw Error('Unsafe provisioning parent');
  const owner = randomBytes(16).toString('hex');
  const directory = join(parent, `worker-${owner}`);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
  const env = { PATH: options.executablePath ?? '/usr/local/bin:/usr/bin:/bin', HOME: directory,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' };
  const command = (name: string, args: string[], timeoutMs = 120000) => execute({ command: name, args, cwd: directory,
    env, timeoutMs, maxOutputBytes: 1048576 });
  let initialized = false;
  let attempted = false;
  let closed = false;
  const ownership = () => {
    if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw Error('Provisioning ownership changed');
  };
  return {
    async provision(input: CompiledConfiguration): Promise<ProvisionedWorker> {
      if (attempted || closed) throw Error('Provisioning session already used');
      attempted = true;
      ownership();
      const verified = compileConfiguration(input.configuration);
      if (verified.canonical !== input.canonical || verified.artifactDigest !== input.artifactDigest) throw Error('Configuration binding mismatch');
      const module = fileURLToPath(new URL('../../modules/docker-worker/', import.meta.url));
      for (const name of ['main.tf', '.terraform.lock.hcl']) copyFileSync(join(module, name), join(directory, name));
      writeFileSync(join(directory, 'canonical.json'), input.canonical, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(directory, 'runtime.auto.tfvars.json'), JSON.stringify({
        canonical_configuration_path: join(directory, 'canonical.json'), configuration_sha256: input.artifactDigest.slice(7), owner,
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
      const config = input.configuration;
      if (inspections.length !== 1 || inspected?.Id !== containerId || inspected.Config?.Labels?.['agent-runtime.owner'] !== owner ||
        inspected.Config?.Labels?.['agent-runtime.configuration'] !== input.artifactDigest.slice(7) || inspected.State?.Running !== true ||
        inspected.Config?.User !== '10001:10001' || inspected.HostConfig?.NetworkMode !== 'none' ||
        inspected.HostConfig?.ReadonlyRootfs !== true || inspected.HostConfig?.Privileged !== false ||
        inspected.HostConfig?.Memory !== config.environment.memoryMiB * 1048576 ||
        inspected.HostConfig?.MemorySwap !== config.environment.memoryMiB * 1048576 ||
        inspected.HostConfig?.NanoCpus !== config.environment.cpu * 1000000000 ||
        inspected.HostConfig?.CapDrop?.includes('ALL') !== true ||
        (inspected.HostConfig?.CapAdd?.length ?? 0) !== 0 ||
        inspected.HostConfig?.SecurityOpt?.includes('no-new-privileges:true') !== true ||
        !Array.isArray(inspected.Mounts) || inspected.Mounts.some((mount: { Type?: string }) => mount.Type !== 'tmpfs') ||
        !mountOptions(inspected.HostConfig?.Tmpfs?.['/workspace'], ['rw', 'exec', 'nosuid', 'nodev']) ||
        !mountOptions(inspected.HostConfig?.Tmpfs?.['/tmp'], ['rw', 'noexec', 'nosuid', 'nodev'])) throw Error('Worker isolation verification failed');
      return { owner, containerId, networkId, directory };
    },
    async close(): Promise<void> {
      if (closed) return;
      ownership();
      if (initialized) {
        await command('tofu', ['destroy', '-auto-approve', '-input=false', '-no-color'], 300000);
        const containers = await command('docker', ['ps', '--all', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`]);
        const networks = await command('docker', ['network', 'ls', '--quiet', '--filter', `label=agent-runtime.owner=${owner}`]);
        if (containers.trim() || networks.trim()) throw Error('Worker cleanup unconfirmed');
      }
      ownership();
      rmSync(directory, { recursive: true });
      closed = true;
    },
  };
}
