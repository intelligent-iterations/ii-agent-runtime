import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azureVmAuthority } from '../../../src/providers/tools/azure-vm-authority.js';

const principal = '00000000-0000-0000-0000-000000000002';
const subscription = '/subscriptions/00000000-0000-0000-0000-000000000001';
const id = `${subscription}/resourceGroups/test/providers/Microsoft.Compute/virtualMachines/worker`;
const role = `${subscription}/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000003`;
const assignment = { properties: { principalId: principal, scope: subscription, roleDefinitionId: role } };
function reader(options: { denies?: unknown; assignments?: unknown; permissions?: unknown; roleId?: string } = {}) {
  return async (url: URL) => {
    assert.equal(url.origin, 'https://management.azure.com');
    assert.equal(url.searchParams.get('api-version'), '2022-04-01');
    if (url.pathname.endsWith('/denyAssignments')) {
      assert.equal(url.searchParams.get('$filter'), 'atScope()');
      return options.denies ?? { value: [] };
    }
    if (url.pathname.endsWith('/roleAssignments')) return options.assignments ?? { value: [assignment] };
    assert.equal(url.pathname, role);
    return { id: options.roleId ?? role, properties: { permissions: options.permissions ?? [
      { actions: ['Microsoft.Compute/virtualMachines/*'], notActions: ['*/read', '*/write'] },
    ] } };
  };
}
test('Azure scopes inherited direct assignments and subtracts NotActions per permission block', async () => {
  const result = await azureVmAuthority(principal, id, 'resourceId', reader());
  assert.deepEqual(result.potentialAuthority, [{ provider: 'azure', operation: 'Microsoft.Compute/virtualMachines/delete', resources: { resourceId: [id] } }]);
  assert.equal(result.evidence.length, 3);
});
test('Azure NotActions is not a deny across separate permissions', async () => {
  const result = await azureVmAuthority(principal, id, 'resource', reader({ permissions: [
    { actions: ['*'], notActions: ['*'] }, { actions: ['microsoft.compute/virtualmachines/DELETE'], notActions: [] },
  ] }));
  assert.equal(result.potentialAuthority.length, 1);
  assert.equal(result.potentialAuthority[0]?.operation, 'Microsoft.Compute/virtualMachines/delete');
});
for (const denies of [{ value: [{}] }, { value: [], nextLink: 'https://attacker.invalid' }, {}]) {
  test(`Azure unresolved deny state blocks authority ${JSON.stringify(denies)}`, async () => {
    const result = await azureVmAuthority(principal, id, 'resourceId', reader({ denies }));
    assert.deepEqual(result.potentialAuthority, []);
  });
}
for (const properties of [
  { ...assignment.properties, principalId: 'another-principal' },
  { ...assignment.properties, scope: `${subscription}/resourceGroups/other` },
  { ...assignment.properties, scope: `${id}-other` },
  { ...assignment.properties, condition: 'unsupported expression' },
  { ...assignment.properties, roleDefinitionId: 'https://attacker.invalid/credentials' },
]) test(`Azure rejects unrelated or conditional assignment ${JSON.stringify(properties)}`, async () => {
  const result = await azureVmAuthority(principal, id, 'resourceId', reader({ assignments: { value: [{ properties }] } }));
  assert.deepEqual(result.potentialAuthority, []);
});
test('Azure refuses incomplete assignments, mismatched definitions and malformed exclusions', async () => {
  for (const options of [
    { assignments: { value: [assignment], nextLink: 'https://attacker.invalid' } },
    { roleId: role + '-wrong' }, { permissions: [{ actions: ['*'], notActions: ['[unsupported]'] }] },
  ]) assert.deepEqual((await azureVmAuthority(principal, id, 'resourceId', reader(options))).potentialAuthority, []);
});
test('Azure read errors remain unknown without exposing exceptions', async () => {
  const result = await azureVmAuthority(principal, id, 'resourceId', async () => { throw Error('private-token'); });
  assert.deepEqual(result.potentialAuthority, []);
  assert.ok(!JSON.stringify(result).includes('private-token'));
  assert.ok(result.limitations.some(item => item.includes('reads failed')));
});
