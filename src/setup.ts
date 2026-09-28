import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

import type { Setup as SchemaSetup } from './generated/setup.js';

type UnionKeys<T> = T extends unknown ? keyof T : never;
type ClosedUnion<T, All = T> = T extends unknown
  ? T & Partial<Record<Exclude<UnionKeys<All>, keyof T>, never>> : never;
export type SecretReference = ClosedUnion<SchemaSetup['secrets'][number]>;
export type GitHubSecretReference = Extract<SecretReference, { provider: 'github' }>;
export type ProviderSecretReference = Exclude<SecretReference, GitHubSecretReference>;
export type Setup = Omit<SchemaSetup, 'secrets'> & { secrets: SecretReference[] };

export interface SetupIssue { path: string; keyword: string }
export class SetupValidationError extends Error {
  constructor(message: string, readonly issues: SetupIssue[]) { super(message); this.name = 'SetupValidationError'; }
}
const schema = JSON.parse(readFileSync(new URL('../schemas/setup.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: true }).compile<Setup>(schema);

/** JSON only: reject lossy values before hashing or retaining a record. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Sparse or augmented arrays are not JSON');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Expected finite JSON data');
}
export function secretIdentity(ref: SecretReference): string {
  return canonicalJson(ref);
}
export function parseSetup(input: unknown): Setup {
  // Copy before validation so caller mutations cannot alter the validated snapshot.
  const copy: unknown = JSON.parse(canonicalJson(input));
  if (!validate(copy)) {
    // Do not echo rejected values, which could include accidentally supplied credentials.
    throw new SetupValidationError(`Invalid setup: ${validate.errors?.map(e => `${e.instancePath || '/'} ${e.keyword}`).join('; ')}`,
      (validate.errors ?? []).map(e => ({ path: e.instancePath, keyword: e.keyword })));
  }
  const identities = copy.secrets.map(secretIdentity);
  for (const reference of copy.secrets) {
    if (reference.organization !== undefined && reference.organization.toLowerCase() !== reference.repository?.split('/')[0]?.toLowerCase()) throw new SetupValidationError('Secret organization must own the repository', [{ path: `/secrets/${copy.secrets.indexOf(reference)}/organization`, keyword: 'organizationOwner' }]);
  }
  if (new Set(identities).size !== identities.length) throw new SetupValidationError('Duplicate secret reference', [{ path: '/secrets', keyword: 'uniqueReferences' }]);
  for (const path of copy.capture.paths) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || p === '')) {
      throw new SetupValidationError('Capture paths must be relative and normalized', [{ path: `/capture/paths/${copy.capture.paths.indexOf(path)}`, keyword: 'normalizedPath' }]);
    }
  }
  copy.secrets.sort((a, b) => secretIdentity(a) < secretIdentity(b) ? -1 : secretIdentity(a) > secretIdentity(b) ? 1 : 0);
  copy.capture.paths.sort();
  return copy;
}
export function setupDigest(input: unknown): string {
  const { revision: _revision, ...resolved } = parseSetup(input);
  return `sha256:${createHash('sha256').update(canonicalJson(resolved)).digest('hex')}`;
}
