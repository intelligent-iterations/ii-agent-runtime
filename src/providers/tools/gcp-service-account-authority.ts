import type { AuthorityResource } from './preflight.js';
import type { PreflightEvidence } from '../../runtime/preflight.js';
import { gcpTroubleshootPermissions, type GcpTroubleshoot } from './gcp-instance-authority.js';

type Authority = NonNullable<AuthorityResource['potentialAuthority']>[number];
/** Reads one project's IAM policy (Cloud Resource Manager `getIamPolicy`). Supplied by the trusted collector. */
export type GcpProjectPolicyRead = (project: string) => Promise<any>;

const MAX_PROJECTS = 4;
/** High-impact project-level permissions checked with Policy Troubleshooter. Roles are listed, not expanded. */
export const gcpServiceAccountPermissions: readonly string[] = Object.freeze([
  'resourcemanager.projects.setIamPolicy', 'iam.serviceAccounts.actAs', 'iam.serviceAccounts.getAccessToken', 'iam.serviceAccountKeys.create',
  'cloudfunctions.functions.update', 'run.services.update', 'firebasehosting.sites.update', 'secretmanager.versions.access',
]);
const role = /^(?:roles|projects\/[a-z0-9-]+\/roles|organizations\/[0-9]+\/roles)\/[A-Za-z0-9_.]{1,128}$/;
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const members = (binding: Record<string, any>): string[] =>
  Array.isArray(binding.members) ? binding.members.filter((item: unknown): item is string => typeof item === 'string') : [];

/** The project that owns a service account, from its email; undefined for accounts of unknown form. */
export function gcpServiceAccountProject(email: string): string | undefined {
  return /^[a-z0-9-]+@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/.exec(email)?.[1]
    ?? /^([0-9]{1,20})-compute@developer\.gserviceaccount\.com$/.exec(email)?.[1]
    ?? /^([a-z][a-z0-9-]{4,28}[a-z0-9])@appspot\.gserviceaccount\.com$/.exec(email)?.[1];
}

/** Project roles bound to a service account and provider-evaluated project permissions.
 * Reads only the named projects' IAM policies; never enumerates projects or other principals' authority.
 */
export async function gcpServiceAccountAuthority(email: string, projects: readonly string[], readPolicy: GcpProjectPolicyRead,
  troubleshoot: GcpTroubleshoot): Promise<{
  potentialAuthority: Authority[];
  /** Roles bound to the account on each project. IAM has not evaluated what they allow. */
  declaredAuthority: Authority[];
  evidence: PreflightEvidence[];
  limitations: string[];
  /** Every binding read on each project, for trust analysis by the caller. */
  bindings: Map<string, unknown[]>;
}> {
  const result = { potentialAuthority: [] as Authority[], declaredAuthority: [] as Authority[], evidence: [] as PreflightEvidence[],
    bindings: new Map<string, unknown[]>(), limitations: [
      'Roles are listed as bound on the named projects only; folder, organization and other projects\' bindings are not listed.',
      'Bound roles are not expanded into permissions; only the checked permissions are provider-evaluated.',
    ] };
  const member = `serviceaccount:${email.toLowerCase()}`;
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    try {
      const policy = await readPolicy(project);
      if (!record(policy) || policy.bindings !== undefined && !Array.isArray(policy.bindings)) throw Error('Invalid policy');
      const bindings: unknown[] = policy.bindings ?? [];
      result.bindings.set(project, bindings);
      result.evidence.push({ source: `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
        resource: `projects/${project}`, observedAt: Date.now() });
      for (const binding of bindings) {
        if (!record(binding) || typeof binding.role !== 'string' || !role.test(binding.role)) continue;
        if (!members(binding).some(item => item.toLowerCase() === member)) continue;
        if (binding.condition) result.limitations.push(`${binding.role} on ${project} is conditional; its condition is not evaluated.`);
        result.declaredAuthority.push({ provider: 'gcp', operation: binding.role, resources: { project: [project] } });
      }
    } catch { result.limitations.push(`The IAM policy of project ${project} could not be read; its role bindings are unknown.`); continue; }
    const checked = await gcpTroubleshootPermissions(email, `//cloudresourcemanager.googleapis.com/projects/${project}`,
      gcpServiceAccountPermissions, { project }, troubleshoot);
    result.potentialAuthority.push(...checked.potentialAuthority);
    result.evidence.push(...checked.evidence);
    result.limitations.push(...checked.limitations);
  }
  if (projects.length > MAX_PROJECTS) result.limitations.push('Project limit reached; further projects are not assessed.');
  return { ...result, limitations: [...new Set(result.limitations)] };
}

// Roles that let a federated GitHub token obtain the service account's access tokens.
const tokenRoles = new Set(['roles/iam.workloadIdentityUser', 'roles/iam.serviceAccountTokenCreator']);
const federated = /^(principalSet|principal):\/\/iam\.googleapis\.com\/projects\/([0-9]+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]+)\/(.+)$/;

/** Whether IAM bindings let a GitHub Actions OIDC token for this job impersonate the service account.
 * Reads `principal`/`principalSet` members for GitHub's conventional attribute mapping. The provider's
 * attribute mapping and condition are not read, so a match means the binding admits the token, not
 * that the provider accepts it.
 */
export function gcpGithubWorkloadIdentityTrust(bindings: readonly unknown[], request: { repository: string; subject?: string; federation?: string }): {
  trust: 'admits' | 'excludes' | 'unknown';
  limitations: string[];
} {
  const limitations = ['The workload identity provider\'s attribute mapping and condition are not read; they can reject tokens a binding admits.'];
  const pool = request.federation ? /^projects\/([0-9]+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]+)\//.exec(request.federation) : null;
  if (!pool) limitations.push('The workflow\'s workload identity provider is not resolved; bindings in every pool are considered.');
  const [owner] = request.repository.toLowerCase().split('/');
  let admits = false;
  let unknown = false;
  for (const binding of bindings) {
    if (!record(binding) || typeof binding.role !== 'string') continue;
    const custom = /^(?:projects|organizations)\//.test(binding.role);
    if (!tokenRoles.has(binding.role) && !custom) continue;
    for (const item of members(binding)) {
      const match = federated.exec(item);
      if (!match || pool && (match[2] !== pool[1] || match[3] !== pool[2])) continue;
      if (custom) { unknown = true; limitations.push(`Custom role ${binding.role} is bound to federated principals and is not expanded.`); continue; }
      const kind = match[1]!;
      const selector = match[4]!;
      let result: 'admits' | 'excludes' | 'unknown';
      if (kind === 'principalSet' && selector === '*') {
        result = 'admits';
        limitations.push('A binding admits every identity in the workload identity pool, not only this repository.');
      } else if (kind === 'principalSet' && selector.startsWith('attribute.repository/')) {
        result = selector.slice('attribute.repository/'.length).toLowerCase() === request.repository.toLowerCase() ? 'admits' : 'excludes';
      } else if (kind === 'principalSet' && selector.startsWith('attribute.repository_owner/')) {
        result = selector.slice('attribute.repository_owner/'.length).toLowerCase() === owner ? 'admits' : 'excludes';
        if (result === 'admits') limitations.push(`A binding admits every repository owned by ${owner}, not only this repository.`);
      } else if (kind === 'principal' && selector.startsWith('subject/')) {
        if (request.subject === undefined) { result = 'unknown'; limitations.push('The job OIDC subject could not be determined from the workflow.'); }
        else result = selector.slice('subject/'.length) === request.subject ? 'admits' : 'excludes';
      } else {
        result = 'unknown';
        limitations.push(`Federated member selector ${selector.split('/')[0]} is not evaluated.`);
      }
      if (result !== 'excludes' && binding.condition) { result = 'unknown'; limitations.push(`A ${binding.role} binding is conditional; its condition is not evaluated.`); }
      if (result === 'admits') admits = true;
      if (result === 'unknown') unknown = true;
    }
  }
  if (!admits && !unknown) limitations.push('No read binding admits this repository\'s tokens; bindings inherited from folders or the organization are not read.');
  return { trust: admits ? 'admits' : unknown ? 'unknown' : 'excludes', limitations: [...new Set(limitations)] };
}
