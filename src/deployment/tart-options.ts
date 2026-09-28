import { isIP } from 'node:net';
import type { Setup } from '../setup.js';

export interface TartOptions {
  os: 'linux' | 'darwin';
  network: { mode: 'softnet'; blockCidrs: string[]; blockHostAddresses: boolean };
  timeouts: { commandMs: number; guestCommandMs: number; addressWaitMs: number; tofuMs: number; tofuLockMs: number };
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error('Explicit Tart provider options are required');
  return value as Record<string, unknown>;
}
/** No deployment defaults: the consumer selects policy before its setup is hashed and checked. */
export function tartOptions(setup: Setup): TartOptions {
  const value = object(setup.deployment.options, ['os', 'network', 'timeouts']);
  if (!['linux', 'darwin'].includes(String(value.os))) throw Error('Invalid Tart guest OS');
  const network = object(value.network, ['mode', 'blockCidrs', 'blockHostAddresses']);
  if (network.mode !== 'softnet' || typeof network.blockHostAddresses !== 'boolean' || !Array.isArray(network.blockCidrs) ||
      new Set(network.blockCidrs).size !== network.blockCidrs.length || network.blockCidrs.some(cidr => {
        if (typeof cidr !== 'string') return true;
        const parts = cidr.split('/');
        return parts.length !== 2 || isIP(parts[0]!) !== 4 || !/^(0|[1-9][0-9]?)$/.test(parts[1]!) || Number(parts[1]) > 32;
      })) throw Error('Invalid Tart network policy');
  const timeouts = object(value.timeouts, ['commandMs', 'guestCommandMs', 'addressWaitMs', 'tofuMs', 'tofuLockMs']);
  if (Object.values(timeouts).some(ms => !Number.isSafeInteger(ms) || Number(ms) < 1 || Number(ms) > 2_147_483_647)) throw Error('Invalid Tart timeout');
  return structuredClone(value) as unknown as TartOptions;
}
