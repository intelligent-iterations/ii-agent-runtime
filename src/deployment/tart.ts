import { tartOptions, type TartOptions } from './tart-options.js';
import { join } from 'node:path';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { commands, toolEnvironment, type CommandExecutor } from './commands.js';
import { durableWrite, loadDeployment, phase, withDeploymentLock, type DeploymentManifest } from './workspace.js';

export interface VMObservation { present: boolean; running: boolean; cpu?: number; memoryMiB?: number; ip?: string }
function options(m: DeploymentManifest) {
  return { cwd: m.directory, env: { ...toolEnvironment(), TART_HOME: join(m.directory, 'tart'), TART_NO_AUTO_PRUNE: '1' }, timeoutMs: tartOptions(m.setup).timeouts.commandMs };
}
async function inventory(m: DeploymentManifest, driver: CommandExecutor): Promise<VMObservation> {
  const inventory: unknown = JSON.parse(await driver.run(m.binaries.tart, ['list', '--format', 'json'], options(m)));
  if (!Array.isArray(inventory) || inventory.some(item => !item || typeof item.Name !== 'string' || typeof item.Source !== 'string' || typeof item.Running !== 'boolean')) throw new Error('Invalid VM inventory');
  // An operation has its own Tart home. Unexpected VMs invalidate ownership assumptions.
  if (inventory.some(item => item.Source === 'local' && item.Name !== m.vmName)) throw new Error('Unexpected VM in deployment directory');
  const matches = inventory.filter(item => item.Source === 'local' && item.Name === m.vmName);
  if (matches.length > 1) throw new Error('Ambiguous VM inventory');
  if (!matches.length) return { present: false, running: false };
  return { present: true, running: matches[0].Running };
}
async function observe(m: DeploymentManifest, driver: CommandExecutor): Promise<VMObservation> {
  const current = await inventory(m, driver);
  if (!current.present) return current;
  const config = JSON.parse(await driver.run(m.binaries.tart, ['get', m.vmName, '--format', 'json'], options(m)));
  if (!Number.isSafeInteger(config.CPU) || !Number.isSafeInteger(config.Memory) || typeof config.Running !== 'boolean' || config.OS !== tartOptions(m.setup).os) throw new Error('Unsupported VM configuration');
  return { present: true, running: config.Running, cpu: config.CPU, memoryMiB: config.Memory };
}
export async function inspectTartDeployment(manifestPath: string, driver = commands): Promise<VMObservation> {
  return observe(loadDeployment(manifestPath), driver);
}
function update(m: DeploymentManifest, value: string): void {
  durableWrite(join(m.directory, 'phase.json'), { phase: value });
}
/** Internal OpenTofu hook. A partial creation requires explicit removal, never a blind second clone. */
async function createTartVMLocked(manifestPath: string, driver = commands): Promise<VMObservation> {
  const m = loadDeployment(manifestPath);
  if (phase(m) !== 'prepared') throw new Error('Creation already attempted; reconcile or remove before retry');
  if ((await observe(m, driver)).present) throw new Error('Refusing to replace an existing VM');
  update(m, 'creating');
  await driver.run(m.binaries.tart, tartCloneArguments(m.setup.deployment.image, m.vmName), options(m));
  await driver.run(m.binaries.tart, ['set', m.vmName, '--cpu', String(m.setup.deployment.cpu), '--memory', String(m.setup.deployment.memoryMiB), '--random-mac'], options(m));
  const configured = await observe(m, driver);
  if (!configured.present || configured.running || configured.cpu !== m.setup.deployment.cpu || configured.memoryMiB !== m.setup.deployment.memoryMiB) throw new Error('VM resource configuration mismatch');
  update(m, 'configured');
  return configured;
}
/** Starting a VM does not start, supervise or retry its workload. */
async function startTartVMLocked(manifestPath: string, driver = commands): Promise<void> {
  const m = loadDeployment(manifestPath);
  if (phase(m) !== 'configured') throw new Error('VM is not ready to start');
  const current = await observe(m, driver);
  if (!current.present || current.running || current.cpu !== m.setup.deployment.cpu || current.memoryMiB !== m.setup.deployment.memoryMiB) throw new Error('VM configuration changed');
  update(m, 'starting');
  await driver.start(m.binaries.tart, ['run', m.vmName, '--no-graphics', '--no-audio', '--no-clipboard', ...tartNetworkArguments(tartOptions(m.setup).network)], options(m), join(m.directory, 'vm.log'));
  // Process creation is not guest readiness. Caller uses inspect/address and its own workload probe.
}
export async function tartAddress(manifestPath: string, driver = commands): Promise<string> {
  const m = loadDeployment(manifestPath);
  if (!(await observe(m, driver)).running) throw new Error('VM is not running');
  const address = (await driver.run(m.binaries.tart, ['ip', m.vmName, '--wait', String(Math.ceil(tartOptions(m.setup).timeouts.addressWaitMs / 1000))], { ...options(m), timeoutMs: tartOptions(m.setup).timeouts.addressWaitMs })).trim();
  if (!isIP(address)) throw new Error('VM address unavailable');
  return address;
}
/** Bounded recovery primitive for incomplete/tainted OpenTofu creation. Consumer initiates it. */
async function removeTartVMLocked(manifestPath: string, driver = commands): Promise<VMObservation> {
  const m = loadDeployment(manifestPath);
  const current = await inventory(m, driver);
  if (current.running) {
    update(m, 'stopping');
    await driver.run(m.binaries.tart, ['stop', m.vmName], options(m));
  }
  if (current.present) {
    update(m, 'removing');
    await driver.run(m.binaries.tart, ['delete', m.vmName], options(m));
  }
  const result = await inventory(m, driver);
  if (result.present) throw new Error('VM removal not confirmed');
  // Each operation owns this cache. Never prune a shared/default Tart home.
  const cache = join(m.directory, 'tart', 'cache');
  let cacheStat;
  try { cacheStat = lstatSync(cache); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (cacheStat) {
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || realpathSync(cache) !== cache || cacheStat.uid !== lstatSync(m.directory).uid) throw Error('Unsafe deployment image cache');
    rmSync(cache, { recursive: true });
  }
  update(m, 'removed');
  return result;
}

export async function createTartVM(manifestPath: string, driver = commands): Promise<VMObservation> {
  return withDeploymentLock(manifestPath, () => createTartVMLocked(manifestPath, driver));
}
export async function startTartVM(manifestPath: string, driver = commands): Promise<void> {
  return withDeploymentLock(manifestPath, () => startTartVMLocked(manifestPath, driver));
}
export async function removeTartVM(manifestPath: string, driver = commands): Promise<VMObservation> {
  return withDeploymentLock(manifestPath, () => removeTartVMLocked(manifestPath, driver));
}

/** Executes a prepared consumer command through the guest agent, without host shares or SSH keys. */
export async function executeTartGuest(
  manifestPath: string, command: string[], input?: string | Uint8Array, driver = commands,
): Promise<string> {
  const m = loadDeployment(manifestPath);
  if (!command.length || !command[0] || command[0].startsWith('-') || command.some(value => value.includes('\0'))) throw new Error('Invalid guest command');
  if (!(await observe(m, driver)).running) throw new Error('VM is not running');
  return driver.run(m.binaries.tart, ['exec', ...(input === undefined ? [] : ['-i']), m.vmName, ...command],
    { ...options(m), timeoutMs: tartOptions(m.setup).timeouts.guestCommandMs, ...(input === undefined ? {} : { input }) });
}

/** Loopback-only development registries can use HTTP; remote image transport remains TLS. */
export function tartCloneArguments(image: string, name: string): string[] {
  const authority = image.split('/')[0] ?? '';
  const loopback = /^(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(authority);
  return ['clone', ...(loopback ? ['--insecure'] : []), image, name];
}


/** Block non-public host/gateway routes before Softnet's implicit gateway exception.
 * Images must use public DNS resolvers; no guest-to-host DNS exception is granted.
 * Host addresses are a launch-time snapshot, not a dynamic network policy.
 */
export function tartNetworkArguments(policy: TartOptions['network'], hostAddresses = Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => item.family === 'IPv4').map(item => item.address))): string[] {
  const blocks = new Set(policy.blockCidrs);
  for (const address of policy.blockHostAddresses ? hostAddresses : []) {
    if (isIP(address) !== 4) throw Error('Invalid host IPv4 address');
    blocks.add(`${address}/32`);
  }
  return ['--net-softnet', ...(blocks.size ? ['--net-softnet-block=' + [...blocks].sort().join(',')] : [])];
}
