import { canonicalJson, digest } from '../runtime/configuration.js';
import type { HostDeployment } from './contracts.js';

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error('Expected deployment object');
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !Object.hasOwn(value, key)))
    throw Error('Unknown or missing deployment field');
}
export function validateDeployment(input: unknown): HostDeployment {
  object(input);
  keys(input, ['schemaVersion', 'id', 'provider', 'infrastructure', 'providerConfiguration']);
  if (
    input.schemaVersion !== 1 ||
    typeof input.id !== 'string' ||
    !/^[a-z][a-z0-9-]{1,30}$/.test(input.id) ||
    typeof input.provider !== 'string'
  )
    throw Error('Invalid deployment identity');
  object(input.infrastructure);
  object(input.providerConfiguration);
  const serialized = canonicalJson(input);
  if (
    serialized.length > 512000 ||
    serialized.includes('-----BEGIN PRIVATE KEY-----') ||
    serialized.includes('-----BEGIN RSA PRIVATE KEY-----')
  )
    throw Error('Deployment contains oversized data or private key material');
  return JSON.parse(serialized) as HostDeployment;
}
export const deploymentDigest = (input: HostDeployment): string => digest(canonicalJson(input));
