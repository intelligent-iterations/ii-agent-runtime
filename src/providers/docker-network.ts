import { isIPv4 } from 'node:net';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvisionedWorker } from './docker-opentofu.js';
import { runTrustedProcess, type ProcessRunner } from './process.js';

/** Installs deny rules before joining a worker to its private bridge. Use only in the destination's ephemeral runner. */
export async function isolateWorkerNetwork(worker: ProvisionedWorker, options: {
  process?: ProcessRunner; executablePath?: string;
}) {
  if (!/^[a-f0-9]{32}$/.test(worker.owner) || !/^[a-f0-9]{64}$/.test(worker.networkId) ||
    !/^[a-f0-9]{64}$/.test(worker.containerId) || realpathSync(worker.directory) !== worker.directory ||
    readFileSync(join(worker.directory, '.owner'), 'utf8') !== worker.owner) throw Error('Worker ownership mismatch');
  const execute = options.process ?? runTrustedProcess;
  const env = { PATH: options.executablePath ?? '/usr/local/bin:/usr/bin:/bin', HOME: worker.directory };
  const run = (command: string, args: string[]) => execute({ command, args, cwd: worker.directory, env, timeoutMs: 20000, maxOutputBytes: 65536 });
  const inspection = JSON.parse(await run('docker', ['network', 'inspect', worker.networkId])) as Array<Record<string, any>>;
  const network = inspection[0];
  const address = network?.IPAM?.Config?.[0]?.Gateway;
  const bridge = `br-${worker.networkId.slice(0, 12)}`;
  if (inspection.length !== 1 || network?.Id !== worker.networkId || network.Labels?.['agent-runtime.owner'] !== worker.owner ||
    network.Internal !== true || network.EnableIPv6 !== false || network.Driver !== 'bridge' ||
    typeof address !== 'string' || !isIPv4(address) || (network.Options?.['com.docker.network.bridge.name'] &&
      network.Options['com.docker.network.bridge.name'] !== bridge) || Object.keys(network.Containers ?? {}).length) throw Error('Private worker network verification failed');
  const tag = `agent-runtime:${worker.owner}`;
  const installed: Array<{ executable: string; chain: string; rule: string[] }> = [];
  let joined = false;
  let closed = false;
  async function rule(executable: string, chain: string, specification: string[]): Promise<void> {
    const args = [...specification, '-m', 'comment', '--comment', tag];
    // Track before execution: a killed client may have successfully installed its rule.
    installed.push({ executable, chain, rule: args });
    await run('sudo', ['--non-interactive', executable, '-w', '10', '-I', chain, '1', ...args]);
    await run('sudo', ['--non-interactive', executable, '-w', '10', '-C', chain, ...args]);
  }
  async function close(): Promise<void> {
    if (closed) return;
    // Disconnect before opening the firewall. Never remove denies while the worker remains attached.
    if (joined) {
      await run('docker', ['network', 'disconnect', '--force', worker.networkId, worker.containerId]);
      joined = false;
    }
    const failures: unknown[] = [];
    for (const entry of [...installed].reverse()) {
      try {
        await run('sudo', ['--non-interactive', entry.executable, '-w', '10', '-D', entry.chain, ...entry.rule]);
        installed.splice(installed.indexOf(entry), 1);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw Error('Worker firewall cleanup unconfirmed');
    closed = true;
  }
  try {
    for (const executable of ['iptables', 'ip6tables']) {
      await rule(executable, 'INPUT', ['-i', bridge, '-j', 'DROP']);
      await rule(executable, executable === 'iptables' ? 'DOCKER-USER' : 'FORWARD', ['-i', bridge, '-j', 'DROP']);
    }
  } catch {
    await close();
    throw Error('Worker firewall setup failed');
  }
  return {
    address,
    async connect(gatewayPort: number): Promise<void> {
      if (joined || closed || !Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw Error('Invalid worker connection');
      await rule('iptables', 'INPUT', ['-i', bridge, '-d', address, '-p', 'tcp', '--dport', String(gatewayPort), '-j', 'ACCEPT']);
      // A worker that ran dependency setup is already detached from every network, including none.
      const before = JSON.parse(await run('docker', ['inspect', worker.containerId])) as Array<Record<string, any>>;
      const attached = Object.keys(before[0]?.NetworkSettings?.Networks ?? {});
      if (before.length !== 1 || before[0]?.Id !== worker.containerId || attached.some(name => name !== 'none')) throw Error('Worker network attachment mismatch');
      if (attached.includes('none')) await run('docker', ['network', 'disconnect', 'none', worker.containerId]);
      joined = true;
      await run('docker', ['network', 'connect', worker.networkId, worker.containerId]);
      const inspected = JSON.parse(await run('docker', ['inspect', worker.containerId])) as Array<Record<string, any>>;
      const networks = Object.values(inspected[0]?.NetworkSettings?.Networks ?? {}) as Array<{ NetworkID?: string }>;
      if (inspected.length !== 1 || inspected[0]?.Id !== worker.containerId || networks.length !== 1 || networks[0]?.NetworkID !== worker.networkId) throw Error('Worker network attachment mismatch');
    },
    close,
  };
}
