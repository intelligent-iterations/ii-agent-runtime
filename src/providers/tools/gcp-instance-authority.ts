import type { AuthorityResource } from './preflight.js';
import type { PreflightEvidence } from '../../runtime/preflight.js';

/** Provider-owned checks on the resource already reached by the agent's grants.
 * No account enumeration, permission probing with the backing key, or mutations.
 */
const permissions = ['compute.instances.get', 'compute.instances.delete', 'compute.instances.setServiceAccount', 'compute.instances.setIamPolicy'];
export const gcpTroubleshooterUrl = 'https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot';
export type GcpTroubleshoot = (body: { accessTuple: { principal: string; fullResourceName: string; permission: string } }) => Promise<any>;
type Authority = NonNullable<AuthorityResource['potentialAuthority']>[number];

/** Ask Policy Troubleshooter about exact permissions on one resource. Only CAN_ACCESS counts as authority. */
export async function gcpTroubleshootPermissions(principal: string, fullResourceName: string, candidates: readonly string[],
  scope: Record<string, string>, evaluate: GcpTroubleshoot): Promise<{ potentialAuthority: Authority[]; evidence: PreflightEvidence[]; limitations: string[] }> {
  const result = { potentialAuthority: [] as Authority[], evidence: [] as PreflightEvidence[], limitations: [] as string[] };
  for (const permission of candidates) {
    const accessTuple = { principal, fullResourceName, permission };
    try {
      const value = await evaluate({ accessTuple });
      if (value?.accessTuple?.principal !== principal || value.accessTuple.fullResourceName !== fullResourceName ||
          value.accessTuple.permission !== permission) { result.limitations.push('A Policy Troubleshooter response did not match its request.'); continue; }
      // Use the overall result, not an allow-policy explanation that a deny or
      // principal access boundary may override. Unknown conditions stay unknown.
      if (value.overallAccessState !== 'CAN_ACCESS') {
        if (value.overallAccessState !== 'CANNOT_ACCESS') result.limitations.push('Some IAM checks have missing information or conditional access.');
        continue;
      }
      result.potentialAuthority.push({ provider: 'gcp', operation: permission,
        resources: Object.fromEntries(Object.entries(scope).map(([key, item]) => [key, [item]])) });
      result.evidence.push({ source: gcpTroubleshooterUrl, resource: `${principal} -> ${permission} ${fullResourceName}`, observedAt: Date.now() });
    } catch { result.limitations.push('Policy Troubleshooter is unavailable for some candidate permissions.'); }
  }
  result.limitations = [...new Set(result.limitations)];
  return result;
}

export async function gcpInstanceAuthority(principal: string, scope: Record<string, string>, evaluate: GcpTroubleshoot,
): Promise<{ potentialAuthority: NonNullable<AuthorityResource['potentialAuthority']>; evidence: PreflightEvidence[]; limitations: string[] }> {
  const fullResourceName = `//compute.googleapis.com/projects/${scope.project}/zones/${scope.zone}/instances/${scope.instance}`;
  const checked = await gcpTroubleshootPermissions(principal, fullResourceName, permissions, scope, evaluate);
  return { ...checked, limitations: [...new Set([
    'Only get, delete, setServiceAccount and setIamPolicy on the reached instance are assessed; other resources and permissions remain unassessed.',
    'Policy Troubleshooter evaluates IAM, not startup-script execution, VM access scopes, service state or organization-policy restrictions on an operation.',
    ...checked.limitations,
  ])] };
}
