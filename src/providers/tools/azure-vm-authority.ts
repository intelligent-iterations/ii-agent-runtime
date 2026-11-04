import type { AuthorityResource } from './preflight.js';
import type { PreflightEvidence } from '../../runtime/preflight.js';

const candidates = ['Microsoft.Compute/virtualMachines/read', 'Microsoft.Compute/virtualMachines/delete',
  'Microsoft.Compute/virtualMachines/write', 'Microsoft.Authorization/roleAssignments/write'];
const version = '2022-04-01';
const roleId = /^\/(?:subscriptions\/[0-9a-f-]{36}\/)?providers\/Microsoft\.Authorization\/roleDefinitions\/[0-9a-f-]{36}$/i;
const actionPattern = /^[a-zA-Z0-9.*\/-]{1,256}$/;
const ancestor = (scope: string, resource: string) => resource.toLowerCase() === scope.toLowerCase() ||
  resource.toLowerCase().startsWith(scope.toLowerCase().replace(/\/$/, '') + '/');
function matches(pattern: string, action: string): boolean {
  const parts = pattern.toLowerCase().split('*');
  const target = action.toLowerCase();
  if (parts.length === 1) return target === parts[0];
  if (!target.startsWith(parts[0]!)) return false;
  let offset = parts[0]!.length;
  for (const part of parts.slice(1, -1)) {
    const found = target.indexOf(part, offset);
    if (found < 0) return false;
    offset = found + part.length;
  }
  const last = parts.at(-1)!;
  return target.endsWith(last) && target.length - last.length >= offset;
}
function allows(permission: any, action: string): boolean {
  if (!permission || !Array.isArray(permission.actions) || !permission.actions.every((item: unknown) => typeof item === 'string') ||
      permission.notActions !== undefined && (!Array.isArray(permission.notActions) || !permission.notActions.every((item: unknown) => typeof item === 'string'))) return false;
  if (![...permission.actions, ...(permission.notActions ?? [])].every(pattern => actionPattern.test(pattern))) return false;
  return permission.actions.some((pattern: string) => matches(pattern, action)) &&
    !(permission.notActions ?? []).some((pattern: string) => matches(pattern, action));
}

/** Bounded direct-assignment analysis, not a general Azure/Entra authorization engine. */
export async function azureVmAuthority(principal: string, id: string, field: string, read: (url: URL) => Promise<any>): Promise<{
  potentialAuthority: NonNullable<AuthorityResource['potentialAuthority']>; evidence: PreflightEvidence[]; limitations: string[];
}> {
  const result = { potentialAuthority: [] as NonNullable<AuthorityResource['potentialAuthority']>[number][], evidence: [] as PreflightEvidence[], limitations: [
    'Only four control-plane actions on the reached VM are assessed. Group-based, eligible/PIM, data-plane and management-group assignments are not analyzed.',
    'Role assignments indicate potential authority; VM code execution, Azure Policy and service-side restrictions remain unverified.',
  ] };
  const url = (path: string, filter = false) => {
    const target = new URL(path, 'https://management.azure.com');
    target.searchParams.set('api-version', version);
    if (filter) target.searchParams.set('$filter', 'atScope()');
    return target;
  };
  const observed = (source: URL, resource: string) => result.evidence.push({ source: source.href, resource, observedAt: Date.now() });
  try {
    const denyUrl = url(`${id}/providers/Microsoft.Authorization/denyAssignments`, true);
    const denies = await read(denyUrl);
    // Do not guess deny applicability or group membership. A complete empty
    // list is the only supported case; deny conditions never silently disappear.
    if (!Array.isArray(denies.value) || denies.nextLink || denies.value.length) {
      result.limitations.push('Deny assignments are present, malformed or incomplete; their applicability is not evaluated.');
      return result;
    }
    observed(denyUrl, id);
    const assignmentsUrl = url(`${id}/providers/Microsoft.Authorization/roleAssignments`, true);
    const assignments = await read(assignmentsUrl);
    if (!Array.isArray(assignments.value) || assignments.nextLink) {
      result.limitations.push('Role assignment listing is malformed or incomplete.'); return result;
    }
    observed(assignmentsUrl, id);
    const allowed = new Set<string>();
    let roleReads = 0;
    for (const assignment of assignments.value) {
      const props = assignment?.properties;
      if (typeof props?.principalId !== 'string' || props.principalId.toLowerCase() !== principal.toLowerCase() ||
          typeof props.scope !== 'string' || !ancestor(props.scope, id)) continue;
      if (props.condition != null && props.condition !== '') {
        result.limitations.push('Conditional role assignments are not evaluated.'); continue;
      }
      if (typeof props.roleDefinitionId !== 'string' || !roleId.test(props.roleDefinitionId)) {
        result.limitations.push('Unsupported role definition reference.'); continue;
      }
      if (roleReads++ >= 16) { result.limitations.push('Role definition read limit reached.'); break; }
      const definitionUrl = url(props.roleDefinitionId);
      const definition = await read(definitionUrl);
      if (typeof definition.id !== 'string' || definition.id.toLowerCase() !== props.roleDefinitionId.toLowerCase() ||
          !Array.isArray(definition.properties?.permissions)) { result.limitations.push('A role definition was malformed or mismatched.'); continue; }
      observed(definitionUrl, props.roleDefinitionId);
      for (const action of candidates) if (definition.properties.permissions.some((permission: unknown) => allows(permission, action))) allowed.add(action);
    }
    result.potentialAuthority = [...allowed].map(operation => ({ provider: 'azure', operation, resources: { [field]: [id] } }));
  } catch { result.limitations.push('Azure role or deny-assignment reads failed; authority remains unverified.'); }
  result.limitations = [...new Set(result.limitations)];
  return result;
}
