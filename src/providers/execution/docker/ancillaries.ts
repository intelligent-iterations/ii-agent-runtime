import { canonicalJson } from '../../../runtime/configuration.js';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOwnedJson } from './retained.js';

/** Written before a host-side network mutation; a guest cannot alter this journal. */
export function retainWorkerNetwork(directory: string, value: {
  owner: string; purpose: 'setup' | 'isolation'; bridge: string; networkId?: string;
}): void {
  if (!/^[a-f0-9]{32}$/.test(value.owner) || (value.purpose === 'setup' ? value.bridge !== `afs-${value.owner.slice(0, 11)}` :
      !/^[a-f0-9]{64}$/.test(value.networkId ?? '') || value.bridge !== `br-${value.networkId!.slice(0, 12)}`)) throw Error('Invalid worker network journal');
  const name = `network-${value.purpose}.json`;
  try { writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (canonicalJson(readOwnedJson(directory, name)) !== canonicalJson(value)) throw Error('Worker network journal conflict');
  }
}

function tokens(line: string): string[] {
  return (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(value => value.startsWith('"') ? JSON.parse(value) as string : value);
}

/** Called only after the worker is absent; it never opens a live worker's firewall. */
export async function reconcileWorkerNetworks(options: {
  directory: string; owner: string; run(command: string, args: string[]): Promise<string>;
}): Promise<void> {
  const bindings = new Map<string, string>();
  for (const purpose of ['setup', 'isolation'] as const) {
    const name = `network-${purpose}.json`;
    if (!existsSync(join(options.directory, name))) continue;
    const value = readOwnedJson(options.directory, name);
    const bridge = purpose === 'setup' ? `afs-${options.owner.slice(0, 11)}` : `br-${String(value.networkId).slice(0, 12)}`;
    if (value.owner !== options.owner || value.purpose !== purpose || value.bridge !== bridge ||
        (purpose === 'isolation' && !/^[a-f0-9]{64}$/.test(value.networkId))) throw Error('Retained network ownership changed');
    bindings.set(purpose === 'setup' ? `agent-runtime-setup:${options.owner}` : `agent-runtime:${options.owner}`, bridge);
  }
  if (!bindings.size) return;
  if (bindings.has(`agent-runtime-setup:${options.owner}`)) {
    const ids = (await options.run('docker', ['network', 'ls', '--quiet', '--filter', `label=agent-runtime.owner=${options.owner}`]))
      .split('\n').map(value => value.trim()).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Retained setup network identity unconfirmed');
      const values = JSON.parse(await options.run('docker', ['network', 'inspect', id]));
      const network = values[0];
      if (values.length !== 1 || network?.Id !== id || network.Labels?.['agent-runtime.owner'] !== options.owner ||
          network.Name !== `agent-runtime-setup-${options.owner}` || network.Driver !== 'bridge' ||
          network.Options?.['com.docker.network.bridge.name'] !== `afs-${options.owner.slice(0, 11)}` || Object.keys(network.Containers ?? {}).length) throw Error('Retained setup network ownership changed');
      await options.run('docker', ['network', 'rm', id]);
    }
  }
  const chains = [['iptables', 'INPUT'], ['iptables', 'DOCKER-USER'], ['ip6tables', 'INPUT'], ['ip6tables', 'FORWARD']] as const;
  function ownedRules(output: string, chain: string): string[][] {
    const rules: string[][] = [];
    for (const line of output.split('\n')) {
      const parts = tokens(line), comment = parts.indexOf('--comment');
      const tag = parts[comment + 1];
      if (comment < 0 || !tag || !bindings.has(tag)) continue;
      const input = parts.indexOf('-i');
      if (parts[0] !== '-A' || parts[1] !== chain || input < 0 || parts[input + 1] !== bindings.get(tag)) throw Error('Retained firewall ownership changed');
      rules.push(parts.slice(2));
    }
    return rules;
  }
  for (const [program, chain] of chains) {
    const output = await options.run('sudo', ['--non-interactive', program, '-w', '10', '-S', chain]);
    for (const rule of ownedRules(output, chain)) await options.run('sudo', ['--non-interactive', program, '-w', '10', '-D', chain, ...rule]);
    const after = await options.run('sudo', ['--non-interactive', program, '-w', '10', '-S', chain]);
    if (ownedRules(after, chain).length) throw Error('Retained firewall cleanup unconfirmed');
  }
}
