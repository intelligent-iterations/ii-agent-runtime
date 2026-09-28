/** Provider-neutral evidence about access, without credential values. */
export interface CapabilityGrant {
  id: string;
  provider: string;
  recipient: string;
  resource: string;
  capabilities: readonly string[];
  authorizedBy: string | null;
  issuedBy: string;
  policyRevision: string;
  attemptId: string | null;
  requestedAt: string;
  grantedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
  observedAt: string | null;
  observation: 'verified' | 'denied' | 'unknown';
}

export type AccessFinding = { grantId: string; reason: 'unknown_actor' | 'stale' | 'expired' | 'denied' | 'unverified' };

/** A stale observation is never interpreted as proof of current access. */
export function assessCapabilityGrant(grant: CapabilityGrant, now: Date, maxAgeMs: number): AccessFinding[] {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw Error('Invalid observation age');
  const findings: AccessFinding[] = [];
  if (!grant.authorizedBy) findings.push({ grantId: grant.id, reason: 'unknown_actor' });
  if (grant.endedAt) return findings;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) findings.push({ grantId: grant.id, reason: 'expired' });
  if (grant.observation === 'denied') findings.push({ grantId: grant.id, reason: 'denied' });
  else if (grant.observation !== 'verified') findings.push({ grantId: grant.id, reason: 'unverified' });
  if (!grant.observedAt || !Number.isFinite(Date.parse(grant.observedAt)) ||
      now.getTime() - Date.parse(grant.observedAt) > maxAgeMs) findings.push({ grantId: grant.id, reason: 'stale' });
  return findings;
}
