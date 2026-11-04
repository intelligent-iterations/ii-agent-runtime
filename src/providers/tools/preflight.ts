import type { PreflightCheck, PreflightEvidence, PreflightInput, PreflightInspector } from '../../runtime/preflight.js';
import type { ToolConstraints, ToolGrant } from '../../runtime/tools.js';

/** Non-secret facts supplied by a trusted provider collector or reviewed inventory import. */
export interface AuthorityResource {
  /** Matches the actual argument/resource fields of a provider operation. */
  scope: ToolConstraints;
  /** Identity used by execution on this resource; this alone does not prove its effective permissions. */
  executionIdentity?: string;
  /** Collected authority of that identity. The checker compares this with grants itself. */
  authority?: readonly { provider: string; operation: string; resources: ToolConstraints }[];
  /** Provider-modeled authority, not a verified executable path. */
  potentialAuthority?: readonly { provider: string; operation: string; resources: ToolConstraints }[];
  limitations?: readonly string[];
  /** An approval the agent cannot alter, satisfy, or bypass. Omitted means unverified. */
  independentApproval?: boolean;
}
export interface AuthorityInventory {
  provider: string;
  evidence: readonly PreflightEvidence[];
  resources: readonly AuthorityResource[];
  /** Explicit completeness for the requested grant scopes, not for the whole cloud account. */
  complete: boolean;
  limitations?: readonly string[];
}
export interface PermissionRule {
  id: string;
  /** Every group needs at least one granted operation. */
  requires: readonly (readonly string[])[];
  summary: string;
  reference: string;
  /** These operations must apply to the same exact resource. */
  sameResource?: boolean;
}
function overlaps(left: ToolConstraints, right: ToolConstraints): boolean {
  return Object.entries(left).every(([key, values]) => !right[key] || values.some(value => right[key]!.includes(value)));
}
function scopeMatches(grant: ToolGrant, resource: AuthorityResource): boolean {
  return Object.entries(grant.resources).every(([key, values]) =>
    resource.scope[key]?.some(value => values.includes(value)) === true);
}

/** Rules live in the provider package. The consumer supplies evidence collection, never a deny checklist. */
export function permissionInspector(options: {
  provider: string;
  rules: readonly PermissionRule[];
  /** Operations for which this revision has a reviewed assessment, even if no rule matches. */
  coveredOperations: readonly string[];
  collect?: (input: PreflightInput) => Promise<AuthorityInventory>;
}): PreflightInspector {
  const coverageId = `${options.provider}.coverage`;
  return {
    provider: options.provider,
    checks: [coverageId, ...options.rules.map(rule => rule.id)],
    async inspect(input) {
      const tools = input.tools.filter(tool => tool.provider === options.provider);
      const toolNames = tools.map(tool => tool.name);
      const grants = input.grants.filter(grant => grant.subject === input.subject && toolNames.includes(grant.tool));
      const op = (grant: ToolGrant) => tools.find(tool => tool.name === grant.tool)!.operation;
      const unsupported = tools.filter(tool => !options.coveredOperations.includes(tool.operation));
      const base = (id: string): PreflightCheck => ({ id, provider: options.provider, status: 'not-applicable', severity: 'info',
        summary: 'The configured grants do not meet this rule\'s operation prerequisites.', tools: toolNames,
        path: [], evidence: [], limitations: ['Known-pattern assessment only; arbitrary code and unlisted escalation techniques are not analyzed.'] });
      const results: PreflightCheck[] = [{ ...base(coverageId), status: unsupported.length ? 'unknown' : 'not-applicable',
        summary: unsupported.length ? `Unsupported operations: ${unsupported.map(tool => tool.operation).join(', ')}` :
          'All configured operation identifiers are covered by this rule catalog; environment coverage is reported per check.' }];
      let inventory: AuthorityInventory | undefined;
      for (const rule of options.rules) {
        const groups = rule.requires.map(group => grants.filter(grant => group.includes(op(grant))));
        if (groups.some(group => !group.length)) { results.push(base(rule.id)); continue; }
        // Preserve grant clauses; permission names alone must not connect disjoint resources.
        if (rule.sameResource && !groups[0]!.some(first => groups.every(group =>
          group.some(grant => overlaps(first.resources, grant.resources) && overlaps(grant.resources, first.resources))))) {
          results.push(base(rule.id)); continue;
        }
        inventory ??= await options.collect?.(input);
        const matched = inventory?.provider === options.provider ? inventory.resources.filter(resource =>
          Object.values(resource.scope).every(values => Array.isArray(values) && values.length === 1) &&
          groups.every(group => group.some(grant => scopeMatches(grant, resource)))) : [];
        const outside = (resource: AuthorityResource, potential = false) => ((potential ? resource.potentialAuthority : resource.authority) ?? []).filter(capability => !input.grants.some(grant => {
          const tool = input.tools.find(item => item.name === grant.tool);
          return tool?.provider === capability.provider && tool.operation === capability.operation &&
            Object.keys(grant.arguments).length === 0 && Object.entries(grant.resources).every(([key, values]) =>
              capability.resources[key]?.length && capability.resources[key]!.every(value => values.includes(value)));
        }));
        // An operation name does not establish control over its payload. Until a
        // provider rule evaluates argument restrictions, constrained clauses can
        // explain a possible path but cannot establish the escalation finding.
        // Preserve the association with this resource: an unrestricted clause
        // for a different resource must not rescue the constrained clause here.
        const exposed = matched.find(resource => resource.executionIdentity && outside(resource).length && resource.independentApproval === false &&
          groups.every(group => group.some(grant => scopeMatches(grant, resource) && Object.keys(grant.arguments).length === 0)));
        const implicated = [...new Set(groups.flat().map(grant => grant.tool))];
        const potential = matched.find(resource => resource.executionIdentity && outside(resource, true).length &&
          groups.every(group => group.some(grant => scopeMatches(grant, resource) && Object.keys(grant.arguments).length === 0)));
        if (exposed) {
          results.push({ ...base(rule.id), status: 'finding', severity: 'high', summary: rule.summary, tools: implicated,
            path: [...rule.requires.map(group => group.join(' or ')), `access as ${exposed.executionIdentity}`,
              ...outside(exposed).map(capability => `${capability.provider}:${capability.operation}`)],
            evidence: inventory!.evidence, limitations: [rule.reference, 'Snapshot assessment; later external changes can invalidate it.'] });
        } else if (potential) {
          results.push({ ...base(rule.id), status: 'finding', severity: 'high', tools: implicated,
            summary: `Potential escalation: ${rule.summary} Provider analysis indicates authority outside the agent's grants; execution conditions remain unverified.`,
            path: [...rule.requires.map(group => group.join(' or ')), `access as ${potential.executionIdentity}`,
              ...outside(potential, true).map(capability => `${capability.provider}:${capability.operation}`)],
            evidence: inventory!.evidence, limitations: [rule.reference, ...(inventory?.limitations ?? []), ...(potential.limitations ?? []),
              'Conditional finding, not proof of an executable escalation path.'] });
        } else {
          // Absence of an existing resource does not clear create/assign capabilities.
          results.push({ ...base(rule.id), status: 'unknown', severity: 'warning', tools: implicated,
            summary: `${rule.summary} The permission combination exists, but its reach or independent protections are not established.`,
            path: [...rule.requires.map(group => group.join(' or ')), ...new Set(matched.flatMap(resource =>
              resource.executionIdentity ? [`resource executes as ${resource.executionIdentity}`] : []))], evidence: inventory?.evidence ?? [],
            limitations: [rule.reference, ...(inventory?.limitations ?? []), ...new Set(matched.flatMap(resource => resource.limitations ?? [])),
              ...(groups.some(group => group.some(grant => Object.keys(grant.arguments).length > 0)) ?
                ['Argument restrictions are enforced by the gateway but their effect on this escalation path has not been evaluated.'] : []),
              'Requires complete, scoped identity, resource and protection evidence; no safe conclusion is inferred from missing resources.'] });
        }
      }
      return results;
    },
  };
}

const awsRules: PermissionRule[] = [
  { id: 'aws.policy-expansion', requires: [['iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:PutRolePolicy', 'iam:PutUserPolicy', 'iam:AttachRolePolicy', 'iam:AttachUserPolicy']],
    summary: 'Policy changes may expand an identity\'s authority.', reference: 'https://github.com/DataDog/pathfinding.cloud/tree/main/data/paths/aws/iam' },
  { id: 'aws.identity-access', requires: [['sts:AssumeRole', 'iam:CreateAccessKey', 'iam:UpdateAssumeRolePolicy']],
    summary: 'The agent may obtain or enable access to another identity.', reference: 'https://github.com/andrewkrug/iam-recon/blob/main/src/edges/sts.rs' },
  { id: 'aws.lambda-create-role', requires: [['iam:PassRole'], ['lambda:CreateFunction'], ['lambda:InvokeFunction']],
    summary: 'The agent may create and execute code under another role.', reference: 'https://github.com/DataDog/pathfinding.cloud/blob/main/data/paths/aws/lambda/lambda-001.yaml' },
  { id: 'aws.lambda-code-role', requires: [['lambda:UpdateFunctionCode'], ['lambda:InvokeFunction']], sameResource: true,
    summary: 'The agent may replace and invoke code under the function\'s execution role.', reference: 'https://github.com/andrewkrug/iam-recon/blob/main/src/edges/lambda.rs' },
];
const gcpRules: PermissionRule[] = [
  { id: 'gcp.identity-access', requires: [['iam.serviceAccounts.getAccessToken', 'iam.serviceAccountKeys.create', 'iam.serviceAccounts.signBlob', 'iam.serviceAccounts.signJwt']],
    summary: 'The agent may obtain access as a service account.', reference: 'https://docs.cloud.google.com/iam/docs/service-account-permissions' },
  { id: 'gcp.execution-identity', requires: [['iam.serviceAccounts.actAs'], ['compute.instances.create', 'run.services.create', 'cloudfunctions.functions.create', 'cloudbuild.builds.create']],
    summary: 'The agent may create executable resources using another service account.', reference: 'https://docs.cloud.google.com/iam/docs/best-practices-service-accounts' },
  { id: 'gcp.startup-code', requires: [['compute.instances.setMetadata'], ['compute.instances.reset', 'compute.instances.start']], sameResource: true,
    summary: 'The agent may change startup code and run it under an attached service account.', reference: 'https://github.com/NetSPI/gcpwn/blob/main/gcpwn/mappings/og_defined_edges.json' },
  { id: 'gcp.policy-expansion', requires: [['resourcemanager.projects.setIamPolicy', 'iam.serviceAccounts.setIamPolicy', 'iam.roles.update']],
    summary: 'Policy or role changes may expand accessible authority.', reference: 'https://github.com/NetSPI/gcpwn/blob/main/gcpwn/mappings/og_defined_edges.json' },
];
const azureRules: PermissionRule[] = [
  { id: 'azure.role-assignment', requires: [['Microsoft.Authorization/roleAssignments/write']],
    summary: 'Role assignment may grant additional authority unless its scope and conditions prevent it.', reference: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/conditions-authorization-actions-attributes' },
  { id: 'azure.application-credentials', requires: [['applications.addPassword', 'servicePrincipals.addPassword']],
    summary: 'Adding application credentials may enable access as its service principal.', reference: 'https://bloodhound.specterops.io/resources/edges/az-add-secret' },
  { id: 'azure.managed-execution', requires: [['Microsoft.Compute/virtualMachines/runCommand/action', 'Microsoft.Compute/virtualMachines/extensions/write']],
    summary: 'Executing code on a VM may expose its managed identity.', reference: 'https://bloodhound.specterops.io/resources/edges/az-managed-identity' },
  { id: 'azure.identity-assignment', requires: [['Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'], ['Microsoft.Compute/virtualMachines/write']],
    summary: 'The agent may attach a managed identity to a controlled VM.', reference: 'https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/managed-identities-faq' },
];
type InventoryCollector = NonNullable<Parameters<typeof permissionInspector>[0]['collect']>;
const inspector = (provider: string, rules: PermissionRule[], reads: string[], collect?: InventoryCollector) => permissionInspector({ provider, rules,
  coveredOperations: [...reads, ...new Set(rules.flatMap(rule => rule.requires.flat()))], ...(collect ? { collect } : {}) });
export const awsPermissionPreflight = (collect?: InventoryCollector): PreflightInspector => inspector('aws', awsRules, ['ec2:DescribeInstances'], collect);
export const gcpPermissionPreflight = (collect?: InventoryCollector): PreflightInspector => inspector('gcp', gcpRules,
  ['compute.instances.list', 'compute.instances.get', 'compute.instances.delete'], collect);
export const azurePermissionPreflight = (collect?: InventoryCollector): PreflightInspector => inspector('azure', azureRules,
  ['Microsoft.Compute/virtualMachines/read'], collect);
