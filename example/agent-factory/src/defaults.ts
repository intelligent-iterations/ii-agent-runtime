import type { TartOptions } from '@intelligent-iterations/ii-agent-runtime';
import type { LibvirtOptions } from '@intelligent-iterations/ii-agent-runtime';
/** Factory policy. Runtime has no implicit image, network, OS or timeout selection. */
export function factoryTartOptions(): TartOptions & Record<string, unknown> { return { os: 'linux', network: { mode: 'softnet', blockCidrs: ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'], blockHostAddresses: true }, timeouts: { commandMs: 300_000, guestCommandMs: 60_000, addressWaitMs: 35_000, tofuMs: 600_000, tofuLockMs: 30_000 } }; }
export function factoryLibvirtOptions(): LibvirtOptions & Record<string, unknown> { return {
  storagePool: 'ii-factory', network: { name: 'ii-factory', blockCidrs: ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16'], blockHostAddresses: true },
  timeouts: { commandMs: 300_000, guestCommandMs: 900_000, tofuMs: 600_000, tofuLockMs: 30_000 },
}; }
export const factoryRunnerOptions = Object.freeze({ groupId: 1, workFolder: '_work' });
