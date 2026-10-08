import { isIPv4 } from 'node:net';
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvisionedWorker } from './provisioning.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';

// Private, link-local (cloud metadata) and carrier-grade NAT ranges: setup reaches the internet, never the runner's neighbours.
const BLOCKED = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8'];
const SETUP_LOG = '/workspace/user/agent-runtime-setup.log';
const MAX_SOURCE_BYTES = 512 * 1048576;

function verifyOwnership(worker: ProvisionedWorker): void {
  if (!/^[a-f0-9]{32}$/.test(worker.owner) || !/^[a-f0-9]{64}$/.test(worker.containerId) || realpathSync(worker.directory) !== worker.directory ||
    readFileSync(join(worker.directory, '.owner'), 'utf8') !== worker.owner) throw Error('Worker ownership mismatch');
}
function tools(worker: ProvisionedWorker, options: { process?: ProcessRunner; executablePath?: string }) {
  const execute = options.process ?? runTrustedProcess;
  const env = { PATH: options.executablePath ?? '/usr/local/bin:/usr/bin:/bin', HOME: worker.directory };
  return (command: string, args: string[], extra: { timeoutMs?: number; input?: Buffer; signal?: AbortSignal } = {}) => execute({ command, args,
    cwd: worker.directory, env, timeoutMs: extra.timeoutMs ?? 20000, maxOutputBytes: 65536,
    ...(extra.input ? { input: extra.input } : {}), ...(extra.signal ? { signal: extra.signal } : {}) });
}

/** Copies a checked-out repository into the worker's tmpfs workspace as the worker user. The worker never sees a credential. */
export async function loadWorkerSource(worker: ProvisionedWorker, directory: string, options: { process?: ProcessRunner; executablePath?: string } = {}): Promise<void> {
  verifyOwnership(worker);
  const run = tools(worker, options);
  const archive = join(worker.directory, 'source.tar');
  try {
    await run('tar', ['-C', directory, '-cf', archive, '.'], { timeoutMs: 120000 });
    if (statSync(archive).size > MAX_SOURCE_BYTES) throw Error('Repository too large to load');
    await run('docker', ['exec', '--user', '10001:10001', worker.containerId, 'mkdir', '-p', '/workspace/repository', '/workspace/user']);
    await run('docker', ['exec', '--interactive', '--user', '10001:10001', worker.containerId, 'tar', '-x', '--no-same-owner', '-C', '/workspace/repository'],
      { timeoutMs: 120000, input: readFileSync(archive) });
  } finally { rmSync(archive, { force: true }); }
}

export interface SetupResult { exitCode: number; seconds: number; timedOut: boolean }

/**
 * Runs dependency installation with internet access before any credential exists in the run. The worker joins a
 * per-run bridge whose traffic to private, link-local and host addresses is dropped; afterwards it is detached, every
 * process it left behind is killed and verified gone, and the bridge and its rules are removed.
 */
export async function runWorkerSetup(worker: ProvisionedWorker, commands: string[], options: {
  timeoutMs: number; process?: ProcessRunner; executablePath?: string; signal?: AbortSignal;
}): Promise<SetupResult> {
  verifyOwnership(worker);
  if (!commands.length || commands.some(command => !command || /[\0\r\n]/.test(command))) throw Error('Invalid setup commands');
  const run = tools(worker, options);
  const name = `agent-runtime-setup-${worker.owner}`;
  const bridge = `afs-${worker.owner.slice(0, 11)}`;
  const tag = `agent-runtime-setup:${worker.owner}`;
  const installed: Array<{ executable: string; chain: string; rule: string[] }> = [];
  let networkId: string | undefined;
  let joined = false;
  const rule = async (executable: string, chain: string, specification: string[]) => {
    const args = [...specification, '-m', 'comment', '--comment', tag];
    installed.push({ executable, chain, rule: args });
    await run('sudo', ['--non-interactive', executable, '-w', '10', '-I', chain, '1', ...args]);
    await run('sudo', ['--non-interactive', executable, '-w', '10', '-C', chain, ...args]);
  };
  const started = Date.now();
  let result: SetupResult | undefined;
  const failures: unknown[] = [];
  try {
    networkId = (await run('docker', ['network', 'create', '--driver', 'bridge', '--label', `agent-runtime.owner=${worker.owner}`,
      '--opt', `com.docker.network.bridge.name=${bridge}`, name])).trim();
    const [network] = JSON.parse(await run('docker', ['network', 'inspect', networkId])) as Array<Record<string, any>>;
    if (!/^[a-f0-9]{64}$/.test(networkId) || network?.Id !== networkId || network.Labels?.['agent-runtime.owner'] !== worker.owner || network.Internal !== false ||
      network.EnableIPv6 !== false || network.Options?.['com.docker.network.bridge.name'] !== bridge || !isIPv4(String(network.IPAM?.Config?.[0]?.Gateway)) ||
      Object.keys(network.Containers ?? {}).length) throw Error('Setup network verification failed');
    await rule('iptables', 'INPUT', ['-i', bridge, '-j', 'DROP']);
    for (const range of BLOCKED) await rule('iptables', 'DOCKER-USER', ['-i', bridge, '-d', range, '-j', 'DROP']);
    for (const chain of ['INPUT', 'FORWARD']) await rule('ip6tables', chain, ['-i', bridge, '-j', 'DROP']);
    await run('docker', ['network', 'disconnect', 'none', worker.containerId]);
    joined = true;
    await run('docker', ['network', 'connect', networkId, worker.containerId]);
    const script = `mkdir -p /workspace/user /workspace/tmp && (set -e\n${commands.join('\n')}\n) > ${SETUP_LOG} 2>&1; echo "$?"`;
    try {
      const output = await run('docker', ['exec', '--user', '10001:10001', '--workdir', '/workspace/repository', '--env', 'HOME=/workspace/user', '--env', 'TMPDIR=/workspace/tmp', '--env', 'CI=true',
        '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', worker.containerId, 'sh', '-c', script], { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
      const exitCode = Number(output.trim());
      result = { exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1, seconds: Math.round((Date.now() - started) / 1000), timedOut: false };
    } catch { result = { exitCode: -1, seconds: Math.round((Date.now() - started) / 1000), timedOut: true }; }
  } finally {
    // Seal before any credential exists: detach, stop everything setup started, then remove the bridge and its rules.
    try {
      if (joined && networkId) await run('docker', ['network', 'disconnect', '--force', networkId, worker.containerId]);
      joined = false;
      await run('docker', ['exec', '--user', '10001:10001', worker.containerId, 'sh', '-c',
        'for p in $(ps -o pid= -u 10001); do [ "$p" = 1 ] || [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null; done; true']);
      const remaining = (await run('docker', ['exec', '--user', '10001:10001', worker.containerId, 'ps', '-o', 'pid=,stat=,comm=']))
        .split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, stat, comm]) => pid && pid !== '1' && !stat?.startsWith('Z') && comm !== 'ps');
      if (remaining.length) throw Error('Setup processes survived');
    } catch (error) { failures.push(error); }
    for (const entry of [...installed].reverse()) {
      try { await run('sudo', ['--non-interactive', entry.executable, '-w', '10', '-D', entry.chain, ...entry.rule]); }
      catch (error) { failures.push(error); }
    }
    if (networkId) await run('docker', ['network', 'rm', networkId]).catch(error => failures.push(error));
  }
  if (failures.length) throw Error('Setup network cleanup unconfirmed');
  return result!;
}
