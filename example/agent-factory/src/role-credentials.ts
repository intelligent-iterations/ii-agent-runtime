import type { SecretReference } from '@intelligent-iterations/ii-agent-runtime';
import type { Role } from './index.js';
/** Role-owned harness binding; the runtime setup still declares the actual secret reference. */
export function authCredentialReference(role: Pick<Role, 'setup' | 'credentialKey' | 'authMode'>): SecretReference {
  if (role.authMode !== 'api-key' || !role.credentialKey) throw Error('Codex API-key roles require an explicit credential key');
  const key = role.credentialKey;
  if (!/^[A-Z_][A-Z0-9_]{0,255}$/.test(key)) throw Error('Invalid Codex API-key name');
  const matches = role.setup.secrets.filter(secret => secret.key === key);
  if (matches.length !== 1) throw Error('Codex authentication requires exactly one declared reference');
  return matches[0]!;
}
