import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awsRoleAuthority, type AwsEvidenceRead } from '../../../src/providers/tools/aws-role-authority.js';

const role = 'arn:aws:iam::123456789012:role/path/worker';
const resource = 'arn:aws:s3:::test-bucket/object';
const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: resource }] };
function reader(evaluation: Record<string, unknown>, calls: string[][], document: unknown = policy): AwsEvidenceRead {
  return async args => {
    calls.push(args);
    switch (args[1]) {
      case 'list-role-policies': return { PolicyNames: ['inline'] };
      case 'get-role-policy': return { PolicyDocument: document };
      case 'list-attached-role-policies': return { AttachedPolicies: [] };
      case 'simulate-principal-policy': return { EvaluationResults: [{ EvalActionName: 's3:GetObject', EvalResourceName: resource,
        EvalDecision: 'allowed', MissingContextValues: [], ...evaluation }] };
      default: throw Error('Unexpected read');
    }
  };
}
test('AWS authority candidates come from the reached role and require a matching allowed simulation', async () => {
  const calls: string[][] = [];
  const result = await awsRoleAuthority(role, reader({}, calls));
  assert.deepEqual(result.potentialAuthority, [{ provider: 'aws', operation: 's3:GetObject', resources: { resource: [resource] } }]);
  assert.deepEqual(calls[0], ['iam', 'list-role-policies', '--role-name', 'worker', '--no-paginate']);
  assert.deepEqual(calls.at(-1), ['iam', 'simulate-principal-policy', '--policy-source-arn', role, '--action-names', 's3:GetObject', '--resource-arns', resource, '--no-paginate']);
  assert.ok(result.evidence.some(item => item.source === 'aws:iam:SimulatePrincipalPolicy'));
  assert.ok(result.limitations.some(item => item.includes('not live authorization')));
});
for (const evaluation of [
  { EvalDecision: 'explicitDeny' }, { EvalDecision: 'implicitDeny' }, { MissingContextValues: ['aws:SourceVpc'] },
  { EvalResourceName: 'arn:aws:s3:::different/object' }, { EvalActionName: 's3:PutObject' },
  { PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: false } },
  { OrganizationsDecisionDetail: { AllowedByOrganizations: false } },
]) test(`AWS rejects insufficient simulation evidence ${JSON.stringify(evaluation)}`, async () => {
  const result = await awsRoleAuthority(role, reader(evaluation, []));
  assert.deepEqual(result.potentialAuthority, []);
});
test('AWS unsupported policy shapes do not become simulated authority', async () => {
  const calls: string[][] = [];
  const result = await awsRoleAuthority(role, reader({}, calls, { Statement: [
    { Effect: 'Allow', Action: '*', Resource: '*' },
    { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::test-bucket/*' },
    { Effect: 'Allow', NotAction: 's3:GetObject', Resource: resource },
  ] }));
  assert.deepEqual(result.potentialAuthority, []);
  assert.ok(!calls.some(args => args[1] === 'simulate-principal-policy'));
  assert.ok(result.limitations.some(item => item.includes('Wildcard action')));
});
test('AWS simulation failure preserves uncertainty without retaining provider errors', async () => {
  const base = reader({}, []);
  const result = await awsRoleAuthority(role, async args => {
    if (args[1] === 'simulate-principal-policy') throw Error('private-reader-key');
    return base(args);
  });
  assert.deepEqual(result.potentialAuthority, []);
  assert.ok(result.limitations.some(item => item.includes('simulation unavailable')));
  assert.ok(!JSON.stringify(result).includes('private-reader-key'));
});

test('AWS follows only the default attached policy version and decodes its document', async () => {
  const arn = 'arn:aws:iam::123456789012:policy/read-object';
  const calls: string[][] = [];
  const base = reader({}, calls);
  const result = await awsRoleAuthority(role, async args => {
    switch (args[1]) {
      case 'list-role-policies': return { PolicyNames: [] };
      case 'list-attached-role-policies': return { AttachedPolicies: [{ PolicyArn: arn }] };
      case 'get-policy': assert.equal(args[3], arn); return { Policy: { DefaultVersionId: 'v2' } };
      case 'get-policy-version':
        assert.deepEqual(args, ['iam', 'get-policy-version', '--policy-arn', arn, '--version-id', 'v2']);
        return { PolicyVersion: { Document: encodeURIComponent(JSON.stringify(policy)) } };
      default: return base(args);
    }
  });
  assert.equal(result.potentialAuthority.length, 1);
  assert.ok(result.evidence.some(item => item.resource === `${arn}/v2`));
});
