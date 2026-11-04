import type { AuthorityResource } from './preflight.js';
import type { PreflightEvidence } from '../../runtime/preflight.js';

/** Fixed IAM read/simulation calls supplied by the trusted AWS collector. */
export type AwsEvidenceRead = (args: string[]) => Promise<any>;
const MAX_POLICIES = 16;
const MAX_CANDIDATES = 32;
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] :
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];

/** Discover candidate permissions from the reached role, then ask IAM to evaluate them.
 * This is deliberately not a local IAM policy engine or an audit of the backing key.
 */
export async function awsRoleAuthority(role: string, read: AwsEvidenceRead): Promise<{
  potentialAuthority: NonNullable<AuthorityResource['potentialAuthority']>;
  /** Exact Allow candidates read from the role's policies. IAM has not evaluated these. */
  declaredAuthority: NonNullable<AuthorityResource['potentialAuthority']>;
  evidence: PreflightEvidence[];
  limitations: string[];
}> {
  const result = { potentialAuthority: [] as NonNullable<AuthorityResource['potentialAuthority']>[number][],
    evidence: [] as PreflightEvidence[], limitations: [
      'IAM simulation is not live authorization; resource policies, RCPs, endpoint policies and execution context can change the outcome.',
      'Lambda update/invocation authority and code-signing restrictions remain unverified.',
    ] };
  const name = role.split('/').at(-1)!;
  const documents: unknown[] = [];
  const observed = (source: string, resource: string) => result.evidence.push({ source, resource, observedAt: Date.now() });
  try {
    const inline = await read(['iam', 'list-role-policies', '--role-name', name, '--no-paginate']);
    if (inline.IsTruncated) result.limitations.push('Inline role-policy listing is truncated.');
    for (const policy of strings(inline.PolicyNames).slice(0, MAX_POLICIES)) {
      if (!/^[\w+=,.@-]{1,128}$/.test(policy)) continue;
      const value = await read(['iam', 'get-role-policy', '--role-name', name, '--policy-name', policy]);
      documents.push(value.PolicyDocument);
      observed('aws:iam:GetRolePolicy', `${role}/${policy}`);
    }
    const attached = await read(['iam', 'list-attached-role-policies', '--role-name', name, '--no-paginate']);
    if (attached.IsTruncated) result.limitations.push('Attached role-policy listing is truncated.');
    for (const policy of (Array.isArray(attached.AttachedPolicies) ? attached.AttachedPolicies : []).slice(0, MAX_POLICIES)) {
      if (typeof policy.PolicyArn !== 'string' || !/^arn:aws:iam::(?:aws|[0-9]{12}):policy\/[\w+=,.@/-]+$/.test(policy.PolicyArn)) continue;
      const metadata = await read(['iam', 'get-policy', '--policy-arn', policy.PolicyArn]);
      const version = metadata.Policy?.DefaultVersionId;
      if (typeof version !== 'string' || !/^v[1-9][0-9]*$/.test(version)) continue;
      const value = await read(['iam', 'get-policy-version', '--policy-arn', policy.PolicyArn, '--version-id', version]);
      documents.push(value.PolicyVersion?.Document);
      observed('aws:iam:GetPolicyVersion', `${policy.PolicyArn}/${version}`);
    }
  } catch { result.limitations.push('Some role policy reads failed; authority discovery is incomplete.'); }
  const candidates = new Map<string, { action: string; resource: string }>();
  for (let document of documents) {
    try { if (typeof document === 'string') document = JSON.parse(decodeURIComponent(document)); }
    catch { result.limitations.push('An IAM policy document could not be decoded.'); continue; }
    if (!document || typeof document !== 'object') continue;
    const raw = (document as { Statement?: unknown }).Statement;
    const statements = Array.isArray(raw) ? raw : [raw];
    for (const statement of statements) {
      if (!statement || statement.Effect !== 'Allow') continue;
      if (statement.NotAction || statement.NotResource) { result.limitations.push('NotAction/NotResource candidate enumeration is unsupported.'); continue; }
      for (const action of strings(statement.Action)) {
        if (!/^[a-zA-Z0-9-]+:[a-zA-Z0-9]+$/.test(action)) {
          result.limitations.push('Wildcard action expansion is unsupported.'); continue;
        }
        for (const resource of strings(statement.Resource)) {
          if (resource === '*' || /[*?$]/.test(resource) || !resource.startsWith('arn:aws:')) {
            result.limitations.push('Wildcard or contextual resource expansion is unsupported.'); continue;
          }
          if (candidates.size >= MAX_CANDIDATES) { result.limitations.push('Authority candidate limit reached.'); break; }
          candidates.set(`${action}\n${resource}`, { action, resource });
        }
      }
    }
  }
  for (const { action, resource } of candidates.values()) {
    try {
      const simulation = await read(['iam', 'simulate-principal-policy', '--policy-source-arn', role,
        '--action-names', action, '--resource-arns', resource, '--no-paginate']);
      if (simulation.IsTruncated || !Array.isArray(simulation.EvaluationResults)) continue;
      const evaluation = simulation.EvaluationResults.find((item: any) => item.EvalActionName === action && item.EvalResourceName === resource);
      if (!evaluation || evaluation.EvalDecision !== 'allowed' || !Array.isArray(evaluation.MissingContextValues) || evaluation.MissingContextValues.length ||
          evaluation.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary === false ||
          evaluation.OrganizationsDecisionDetail?.AllowedByOrganizations === false) continue;
      result.potentialAuthority.push({ provider: 'aws', operation: action, resources: { resource: [resource] } });
      observed('aws:iam:SimulatePrincipalPolicy', `${role} -> ${action} ${resource}`);
    } catch { result.limitations.push('IAM simulation unavailable for a candidate permission.'); }
  }
  result.limitations = [...new Set(result.limitations)];
  return { ...result, declaredAuthority: [...candidates.values()].map(({ action, resource }) =>
    ({ provider: 'aws', operation: action, resources: { resource: [resource] } })) };
}

const githubOidcProvider = /^arn:aws:iam::[0-9]{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/;
const githubClaim = 'token.actions.githubusercontent.com:';
const like = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(value);

/** Whether a role trust policy admits a GitHub Actions OIDC token with GitHub's default subject.
 * Supports Allow statements with StringEquals/StringLike on the sub and aud claims. Anything else stays unknown.
 */
export function awsGithubOidcTrust(document: unknown, request: { subject?: string; audience?: string }): {
  trust: 'admits' | 'excludes' | 'unknown';
  limitations: string[];
} {
  const limitations: string[] = [];
  try { if (typeof document === 'string') document = JSON.parse(decodeURIComponent(document)); }
  catch { return { trust: 'unknown', limitations: ['The role trust policy could not be decoded.'] }; }
  if (!document || typeof document !== 'object') return { trust: 'unknown', limitations: ['The role trust policy is missing.'] };
  const raw = (document as { Statement?: unknown }).Statement;
  const statements = (Array.isArray(raw) ? raw : [raw]).filter(item => item && typeof item === 'object') as Record<string, any>[];
  const audience = request.audience ?? 'sts.amazonaws.com';
  const results: ('admits' | 'excludes' | 'unknown')[] = [];
  for (const statement of statements) {
    if (statement.Effect === 'Deny') { limitations.push('Deny statements in the role trust policy are not evaluated.'); continue; }
    if (statement.Effect !== 'Allow') continue;
    if (statement.NotAction || statement.NotPrincipal) { results.push('unknown'); limitations.push('NotAction/NotPrincipal trust statements are unsupported.'); continue; }
    const actions = strings(statement.Action);
    if (!actions.some(action => ['sts:AssumeRoleWithWebIdentity', 'sts:*', '*'].includes(action))) continue;
    const federated = strings(statement.Principal?.Federated);
    if (!federated.some(principal => githubOidcProvider.test(principal))) continue;
    let result: 'admits' | 'excludes' | 'unknown' = 'admits';
    let subjectRestricted = false;
    const conditions = statement.Condition && typeof statement.Condition === 'object' ? statement.Condition as Record<string, unknown> : {};
    for (const [operator, block] of Object.entries(conditions)) {
      if (!block || typeof block !== 'object') { result = 'unknown'; continue; }
      for (const [rawKey, rawValues] of Object.entries(block as Record<string, unknown>)) {
        const key = rawKey.toLowerCase();
        const values = strings(rawValues);
        if (!['StringEquals', 'StringLike'].includes(operator) || !key.startsWith(githubClaim) || !values.length ||
            !['sub', 'aud'].includes(key.slice(githubClaim.length))) {
          result = 'unknown'; limitations.push(`Trust condition ${operator} ${rawKey} is not evaluated.`); continue;
        }
        const claim = key.endsWith(':sub') ? request.subject : audience;
        if (key.endsWith(':sub')) subjectRestricted = true;
        if (claim === undefined) { result = 'unknown'; limitations.push('The job OIDC subject could not be determined from the workflow.'); continue; }
        const matched = values.some(value => operator === 'StringEquals' ? value === claim : like(value, claim));
        if (!matched && result !== 'unknown') result = 'excludes';
        if (matched && operator === 'StringLike' && key.endsWith(':sub') && values.some(value => value.includes('*')))
          limitations.push('The trust policy admits the job through a wildcard subject pattern that may admit other branches or repositories.');
      }
    }
    if (!subjectRestricted && result === 'admits') limitations.push('The trust policy does not restrict the OIDC subject: any GitHub repository can request this role.');
    results.push(result);
  }
  if (!results.length) return { trust: 'excludes', limitations: [...limitations, 'No trust statement admits GitHub Actions OIDC tokens.'] };
  return { trust: results.includes('admits') ? 'admits' : results.includes('unknown') ? 'unknown' : 'excludes', limitations: [...new Set(limitations)] };
}
