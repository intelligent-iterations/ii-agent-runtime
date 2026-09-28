import { parseSetup, setupDigest, type SecretReference } from '@intelligent-iterations/ii-agent-runtime';
import type { Role } from './index.js';

export interface RolePermissions {
  evidence: 'declared';
  kind: Role['kind'];
  setupId: string;
  setupRevision: string;
  setupDigest: string;
  secrets: Array<{ reference: SecretReference; environmentVariable: string; purpose: 'harness-auth' }>;
  githubPermissions: Record<string, 'read' | 'write'>;
}
/** Describe reference assignments; no credential values or provider eligibility claim. */
export function describeRolePermissions(role: Role): RolePermissions {
  const setup = parseSetup(role.setup);
  return {
    evidence: 'declared', kind: role.kind, setupId: setup.id, setupRevision: setup.revision, setupDigest: setupDigest(setup),
    secrets: setup.secrets.map(reference => ({ reference: structuredClone(reference), environmentVariable: reference.key,
      purpose: 'harness-auth' })), githubPermissions: structuredClone(role.githubPermissions ?? {}),
  };
}
