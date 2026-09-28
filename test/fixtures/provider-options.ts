import type { TartOptions } from '../../src/deployment/tart-options.js';
/** Explicit test/verification inputs, not runtime defaults. */
export function testTartOptions(): TartOptions & Record<string, unknown> { return { os: 'linux', network: { mode: 'softnet', blockCidrs: ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'], blockHostAddresses: true }, timeouts: { commandMs: 300_000, guestCommandMs: 60_000, addressWaitMs: 35_000, tofuMs: 600_000, tofuLockMs: 30_000 } }; }
