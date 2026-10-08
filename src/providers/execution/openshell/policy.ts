import { isIPv4 } from 'node:net';
import { canonicalJson } from '../../../runtime/data.js';
import { parseDocument } from 'yaml';

export const OPENSHELL_VERSION = '0.1.2';
export const OPENSHELL_WORKSPACE = '/sandbox';

/** One HTTP route to our mediator; no provider rules, advisor, or alternate network route. */
export function openshellPolicy(address?: string, port?: number) {
  if (address !== undefined && (!isIPv4(address) || !Number.isInteger(port) || port! < 1 || port! > 65535)) throw Error('Invalid OpenShell gateway endpoint');
  return {
    version: 1,
    filesystem_policy: { include_workdir: false,
      read_only: ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/dev', '/var/log', '/dev/urandom'],
      read_write: [OPENSHELL_WORKSPACE, '/tmp', '/dev/null'] },
    landlock: { compatibility: 'hard_requirement' },
    process: { run_as_user: '10001', run_as_group: '10001' },
    network_policies: address === undefined ? {} : {
      runtime_gateway: { name: 'runtime_gateway',
        endpoints: [{ host: address, port, protocol: 'rest', enforcement: 'enforce', access: 'full' }],
        // The node bootstrap launches the harness and Git; child processes inherit the rule.
        binaries: [{ path: '/usr/local/bin/node' }] },
    },
  };
}

/** Compare the full effective policy, including filesystem and process identity, with the requested policy. */
export function verifyOpenShellPolicy(source: string, expected: OpenShellPolicy): void {
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw Error('Invalid OpenShell effective policy');
  const actual = doc.toJS({ maxAliasCount: 0 });
  // v0.1.2 omits an empty network policy map when serializing its effective policy.
  if (actual && typeof actual === 'object' && !Array.isArray(actual) && !Object.hasOwn(actual, 'network_policies')) actual.network_policies = {};
  if (canonicalJson(actual) !== canonicalJson(expected)) throw Error('OpenShell effective policy differs from the requested policy');
}

export function openshellSetupPolicy(address: string, port: number) {
  openshellPolicy(address, port); // Shared endpoint validation.
  return { ...openshellPolicy(), network_policies: {
    dependency_setup: { name: 'dependency_setup',
      endpoints: [{ host: address, port, tls: 'skip', enforcement: 'enforce' }],
      binaries: [{ path: '/**' }] },
  } };
}
export type OpenShellPolicy = ReturnType<typeof openshellPolicy> | ReturnType<typeof openshellSetupPolicy>;
