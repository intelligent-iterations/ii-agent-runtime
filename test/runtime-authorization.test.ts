import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeInvocation, type InvocationEvidence, type InvocationPolicy } from '../src/runtime/authorization.js';
import { digest } from '../src/runtime/configuration.js';

const now = 1_790_000_000_000;
function evidence(): InvocationEvidence {
  return { resource: 'repository:101', event: 'submitted', subjectId: 'issue:3', authorId: 'user:20', actorId: 'user:20',
    actorCapabilities: ['repository:write'], currentLabels: [], originalInputDigest: digest('issue'), currentInputDigest: digest('issue'),
    policyDigest: digest('policy'), currentPolicyDigest: digest('policy'), observedAt: now, open: true, runId: '100', attempt: 1 };
}
const author: InvocationPolicy = { mode: 'authorized-author', requiredCapability: 'repository:write' };

test('counterfactual mutations invalidate each required authorization fact', () => {
  assert.equal(authorizeInvocation(author, 'repository:101', evidence(), now).allowed, true);
  const mutations: Partial<InvocationEvidence>[] = [
    { resource: 'repository:102' }, { open: false }, { actorId: 'user:21' }, { authorId: '' }, { runId: '' },
    { actorCapabilities: [] }, { event: 'approved' }, { originalInputDigest: digest('different issue') },
    { currentPolicyDigest: digest('new policy') }, { observedAt: now - 60_001 }, { observedAt: now + 1 },
    { attempt: 0 }, { attempt: 2 }, { subjectId: '' }, { policyDigest: '' },
  ];
  for (const mutation of mutations) {
    const result = authorizeInvocation(author, 'repository:101', { ...evidence(), ...mutation }, now);
    assert.equal(result.allowed, false, JSON.stringify(mutation));
  }
});

test('a label alone never authorizes a maintainer approval', () => {
  const policy: InvocationPolicy = { mode: 'maintainer-approval', label: 'sample:approve', requiredCapability: 'repository:maintain' };
  const approval: InvocationEvidence = { ...evidence(), actorId: 'user:30', actorCapabilities: ['repository:maintain'],
    event: 'approved', label: 'sample:approve', currentLabels: ['sample:approve'] };
  assert.equal(authorizeInvocation(policy, 'repository:101', approval, now).allowed, true);
  for (const mutation of [{ actorCapabilities: [] }, { event: 'submitted' as const }, { label: 'unrelated' }, { currentLabels: [] },
    { currentInputDigest: digest('edited after approval') }]) {
    assert.equal(authorizeInvocation(policy, 'repository:101', { ...approval, ...mutation }, now).allowed, false);
  }
});

test('reruns recheck original authority and require current rerunner authority', () => {
  const run: InvocationEvidence = { ...evidence(), attempt: 2, rerun: { actorId: 'user:40', capabilities: ['invocation:rerun'] } };
  assert.equal(authorizeInvocation(author, 'repository:101', run, now).allowed, true);
  assert.equal(authorizeInvocation(author, 'repository:101', { ...run, actorCapabilities: [] }, now).allowed, false);
  assert.equal(authorizeInvocation(author, 'repository:101', { ...run, rerun: { actorId: 'user:40', capabilities: [] } }, now).allowed, false);
});

test('public submission mode requires explicit opt-in, authentic submission and unchanged content', () => {
  const policy: InvocationPolicy = { mode: 'any-author', allowPublicContributors: true };
  const stranger = { ...evidence(), actorCapabilities: [] };
  assert.equal(authorizeInvocation(policy, 'repository:101', stranger, now).allowed, true);
  assert.equal(authorizeInvocation(policy, 'repository:101', { ...stranger, event: 'approved' }, now).allowed, false);
  assert.equal(authorizeInvocation(policy, 'repository:101', { ...stranger, currentInputDigest: digest('new') }, now).allowed, false);
});

test('generated event sequences cannot keep a prior authorization after facts change', () => {
  let seed = 47;
  let current = evidence();
  for (let i = 0; i < 300; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    switch (seed % 5) {
      case 0: current.actorCapabilities = current.actorCapabilities.length ? [] : ['repository:write']; break;
      case 1: current.open = !current.open; break;
      case 2: current.currentPolicyDigest = digest(i % 2 ? 'policy' : 'changed'); break;
      case 3: current.currentInputDigest = digest(i % 2 ? 'issue' : 'edited'); break;
      case 4: current = evidence(); break;
    }
    const decision = authorizeInvocation(author, 'repository:101', current, now);
    if (!current.open || !current.actorCapabilities.length || current.currentPolicyDigest !== current.policyDigest || current.currentInputDigest !== current.originalInputDigest) {
      assert.equal(decision.allowed, false, `seed 47 step ${i}`);
    }
  }
});
