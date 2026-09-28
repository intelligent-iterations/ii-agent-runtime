import { isIP } from 'node:net';
import type { Setup } from '../setup.js';

export interface LibvirtOptions {
  storagePool: string;
  network: { name: string; blockCidrs: string[]; blockHostAddresses: true };
  timeouts: { commandMs: number; guestCommandMs: number; tofuMs: number; tofuLockMs: number };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw Error('Explicit libvirt provider options are required');
  }
  return value as Record<string, unknown>;
}

/** The caller chooses a libvirt NAT network; this adapter never creates host networking. */
export function libvirtOptions(setup: Setup): LibvirtOptions {
  if (setup.deployment.provider !== 'libvirt') throw Error('Expected libvirt setup');
  const value = object(setup.deployment.options, ['storagePool', 'network', 'timeouts']);
  if (typeof value.storagePool !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.storagePool)) throw Error('Invalid libvirt storage pool');
  const network = object(value.network, ['name', 'blockCidrs', 'blockHostAddresses']);
  if (typeof network.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(network.name) ||
      network.blockHostAddresses !== true || !Array.isArray(network.blockCidrs) ||
      new Set(network.blockCidrs).size !== network.blockCidrs.length || network.blockCidrs.some(cidr => {
        if (typeof cidr !== 'string') return true;
        const parts = cidr.split('/');
        return parts.length !== 2 || isIP(parts[0]!) !== 4 ||
          !/^(0|[1-9][0-9]?)$/.test(parts[1]!) || Number(parts[1]) > 32;
      })) throw Error('Invalid libvirt network policy');
  const timeouts = object(value.timeouts, ['commandMs', 'guestCommandMs', 'tofuMs', 'tofuLockMs']);
  if (Object.values(timeouts).some(ms => !Number.isSafeInteger(ms) || Number(ms) < 1 || Number(ms) > 2_147_483_647)) {
    throw Error('Invalid libvirt timeout');
  }
  return structuredClone(value) as unknown as LibvirtOptions;
}
