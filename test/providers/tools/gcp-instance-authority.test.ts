import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gcpInstanceAuthority } from '../../../src/providers/tools/gcp-instance-authority.js';

const principal = 'worker@test-project.iam.gserviceaccount.com';
const scope = { project: 'test-project', zone: 'us-central1-a', instance: 'worker' };
test('GCP uses provider-owned permission candidates scoped to the reached instance', async () => {
  const calls: string[] = [];
  const result = await gcpInstanceAuthority(principal, scope, async ({ accessTuple }) => {
    assert.equal(accessTuple.principal, principal);
    assert.equal(accessTuple.fullResourceName, '//compute.googleapis.com/projects/test-project/zones/us-central1-a/instances/worker');
    calls.push(accessTuple.permission);
    return { accessTuple, overallAccessState: accessTuple.permission === 'compute.instances.delete' ? 'CAN_ACCESS' : 'CANNOT_ACCESS' };
  });
  assert.deepEqual(calls, ['compute.instances.get', 'compute.instances.delete', 'compute.instances.setServiceAccount', 'compute.instances.setIamPolicy']);
  assert.deepEqual(result.potentialAuthority, [{ provider: 'gcp', operation: 'compute.instances.delete', resources: {
    project: ['test-project'], zone: ['us-central1-a'], instance: ['worker'] } }]);
  assert.equal(result.evidence.length, 1);
});
for (const state of ['CANNOT_ACCESS', 'UNKNOWN_INFO', 'UNKNOWN_CONDITIONAL', 'OVERALL_ACCESS_STATE_UNSPECIFIED']) {
  test(`GCP overall ${state} cannot be overridden by an allow explanation`, async () => {
    const result = await gcpInstanceAuthority(principal, scope, async ({ accessTuple }) => ({
      accessTuple, overallAccessState: state, allowPolicyExplanation: { allowAccessState: 'ALLOW_ACCESS_STATE_GRANTED' },
    }));
    assert.deepEqual(result.potentialAuthority, []);
  });
}
for (const field of ['principal', 'permission', 'fullResourceName']) test(`GCP rejects a mismatched ${field}`, async () => {
  const result = await gcpInstanceAuthority(principal, scope, async ({ accessTuple }) => ({
    accessTuple: { ...accessTuple, [field]: 'different' }, overallAccessState: 'CAN_ACCESS',
  }));
  assert.deepEqual(result.potentialAuthority, []);
  assert.ok(result.limitations.some(item => item.includes('did not match')));
});
test('GCP unavailable troubleshooting stays unknown and discards provider exceptions', async () => {
  const result = await gcpInstanceAuthority(principal, scope, async () => { throw Error('private-token'); });
  assert.deepEqual(result.potentialAuthority, []);
  assert.ok(result.limitations.some(item => item.includes('unavailable')));
  assert.ok(!JSON.stringify(result).includes('private-token'));
});
