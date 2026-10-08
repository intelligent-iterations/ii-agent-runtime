import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileConfiguration, digest } from '../../../../src/runtime/configuration.js';
import { createGitHubApi, type GitHubApi } from '../../../../src/providers/source/github/http.js';
import { authorizeIssueTask, githubOrderedAdmissionStore, type IssueRequestReader, type IssueTriggerOptions } from '../../../../src/providers/source/github/issue.js';
import { reserveInvocationOrdered, type OrderedAdmissionStore, type Reservation } from '../../../../src/runtime/admission.js';
import type { ConsumerIdentity } from '../../../../src/runtime/consumer.js';
import { fixture, issueOptions } from '../../../runtime-fixture.js';

// A neutral consumer and request format: the runtime assumes nothing about who uses it or how their issues look.
const consumer: ConsumerIdentity = { name: 'sample-app', displayName: 'Sample App' };
const form = (repository: string, task = 'Fix the sample') => `repo: ${repository}\n\n${task}`;
const readRequest: IssueRequestReader = body => {
  const match = /^repo: ([a-z0-9-]+)$/m.exec(String(body));
  return { repository: match ? `example/${match[1]}` : undefined, base: undefined };
};

const control = { repository: 'example/control', repositoryId: 5, runId: 70, attempt: 1, workflowSha: 'a'.repeat(40) };
function scenario(mutation: string, setup: { policy?: ReturnType<typeof fixture>['launchPolicy']; target?: string; action?: string } = {}) {
  const name = setup.target ?? 'project';
  const input = { ...fixture(), source: { ...fixture().source, repository: `example/${name}` } };
  if (setup.policy) input.launchPolicy = setup.policy;
  const compiled = compileConfiguration(input);
  const current = mutation === 'policy' ? compileConfiguration({ ...input, instructions: `${input.instructions} Changed.` }) : compiled;
  const author = { id: 20, login: 'example-user' };
  const issue = { id: 300, number: 3, title: 'Fix it', body: form(name), user: author, state: 'open', labels: [{ name: 'sample:approve' }] };
  const action = setup.action ?? (mutation === 'labeled' || mutation === 'label-denied' ? 'labeled' : mutation.startsWith('reopened') ? 'reopened' : 'opened');
  const sender = mutation === 'reopened-other' || mutation === 'labeled' || mutation === 'label-denied' ? { id: 30, login: 'maintainer' } : author;
  const event = { action, label: { name: 'sample:approve' }, repository: { id: 5, full_name: 'example/control' }, issue, sender };
  const controlApi = createGitHubApi({ credential: () => 'synthetic-control-token', fetch: async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/repos/example/control') return Response.json({ id: 5, default_branch: 'main' });
    if (path === '/repos/example/control/actions/runs/70') return Response.json({ id: 70, run_number: mutation === 'startup-limit' ? 21 : 1, run_attempt: 1,
      event: mutation === 'event' ? 'workflow_dispatch' : 'issues', head_sha: 'a'.repeat(40), path: '.github/workflows/sample-app.yml',
      actor: mutation === 'actor' ? { id: 99, login: 'someone' } : sender, triggering_actor: sender });
    if (path === '/repos/example/control/issues/3') return Response.json({ ...issue,
      body: mutation === 'retarget' ? form('other-repo') : mutation === 'edited' ? form(name, 'Different task') : issue.body });
    throw Error(`Unexpected control repository request ${path}`);
  } });
  const targetApi = createGitHubApi({ credential: () => 'synthetic-read-token', fetch: async url => {
    const path = new URL(String(url)).pathname;
    if (path === `/repos/example/${name}`) return Response.json({ id: name === 'control' ? 5 : 101, full_name: `example/${name}`, archived: mutation === 'archived', disabled: false, default_branch: 'main' });
    const permission = new RegExp(`^/repos/example/${name}/collaborators/([a-z-]+)/permission$`).exec(path);
    if (permission) {
      const user = permission[1] === 'maintainer' ? 30 : 20;
      const level = mutation === 'revoked' || (mutation === 'label-denied' && user === 30) ? 'read' : 'write';
      return Response.json({ user: { id: user }, permission: level, role_name: level });
    }
    throw Error(`Unexpected target request ${path}`);
  } });
  return { control: controlApi, target: targetApi, compiled, current, event, repository: `example/${name}` };
}
const at = () => 1_000_000;
const authorize = (state: ReturnType<typeof scenario>, options: IssueTriggerOptions = issueOptions, repository = state.repository) =>
  authorizeIssueTask({ ...state, run: control, repository, consumer, readRequest, options, now: at });

test('an issue starts an agent only for a verified run, a stable target and an actor with access to that target', async () => {
  const expectations: Record<string, boolean | 'throws'> = { none: true, revoked: false, policy: false, edited: false, 'reopened-author': true, 'reopened-other': false,
    actor: 'throws', event: 'throws', 'startup-limit': 'throws', retarget: 'throws', archived: 'throws' };
  for (const [mutation, expected] of Object.entries(expectations)) {
    const operation = authorize(scenario(mutation));
    if (expected === 'throws') await assert.rejects(operation, /GitHub request failed/, mutation);
    else assert.equal((await operation).decision.allowed, expected, mutation);
  }
  const approval = { mode: 'maintainer-approval' as const, minimumPermission: 'write' as const, label: 'sample:approve' };
  const result = await authorize(scenario('labeled', { policy: approval }));
  assert.deepEqual([result.decision.allowed, result.evidence.event, result.targetId, result.base, result.defaultBranch], [true, 'approved', 101, 'main', 'main']);
  assert.deepEqual(result.task, { reference: 'issue-3', label: 'Issue #3', title: 'Fix it', body: form('project') });
  assert.equal((await authorize(scenario('label-denied', { policy: approval }))).decision.reason, 'approver-denied');
  const self = scenario('none');
  await assert.rejects(authorize(self, issueOptions, 'example/control'), /TARGET_MISMATCH/, 'the control repository itself is not a target by default');
  const granted = compileConfiguration({ ...fixture(), source: { ...fixture().source, repository: 'example/project',
    additionalRepositories: [{ repository: 'example/control', permissions: { contents: 'write' } }] } });
  await assert.rejects(authorize({ ...self, compiled: granted, current: granted }), /TARGET_MISMATCH/, 'nor is it reachable as an additional repository');
});

test('a consumer may take issues in the repository they change, and choose which issue actions count', async () => {
  const same = scenario('none', { target: 'control' });
  await assert.rejects(authorize(same), /TARGET_MISMATCH/);
  const allowed = await authorize(same, { ...issueOptions, allowControlTarget: true });
  assert.deepEqual([allowed.decision.allowed, allowed.targetId], [true, 5]);
  const edited = scenario('none', { action: 'edited' });
  await assert.rejects(authorize(edited), /EVENT_IDENTITY/, 'editing does not submit unless the consumer says so');
  assert.equal((await authorize(edited, { ...issueOptions, submitActions: ['opened', 'edited'] })).decision.allowed, true);
  const approval = { mode: 'maintainer-approval' as const, minimumPermission: 'write' as const, label: 'sample:approve' };
  await assert.rejects(authorize(scenario('labeled', { policy: approval }), { ...issueOptions, approveByLabel: false }), /EVENT_IDENTITY/);
  await assert.rejects(authorize(scenario('none'), { ...issueOptions, submitActions: ['closed' as never] }), /TRIGGER_OPTIONS/);
});


function memoryStore(): OrderedAdmissionStore & { records: Array<{ position: number; reservation: Reservation; admitted?: boolean }>; hidden: Set<number> } {
  const records: Array<{ position: number; reservation: Reservation; admitted?: boolean }> = [];
  const hidden = new Set<number>();
  let next = 100;
  return { records, hidden,
    append: async reservation => { records.push({ position: next, reservation }); return next++; },
    read: async () => records.filter(entry => !hidden.has(entry.position)).map(entry => ({ ...entry })),
    settle: async (position, admitted) => { records.find(entry => entry.position === position)!.admitted = admitted; } };
}
const instant = { sleep: async () => {} };

test('ordered admission lets concurrent launches agree without a lock, and a refused attempt can be retried', async () => {
  const limits = { ...fixture().limits, enabled: true, maxConcurrent: 1, maxRunsPerSubject: 2 };
  const input = (runId: string, subjectId: string, task = 'task') => ({ resource: 'example/control', subjectId, runId, attempt: 1, inputDigest: digest(task), policyDigest: digest('policy') });
  const now = Date.UTC(2026, 8, 30, 12);
  const store = memoryStore();
  assert.equal((await reserveInvocationOrdered(store, limits, input('1', 'issue:1'), now, instant)).allowed, true);
  assert.deepEqual(await reserveInvocationOrdered(store, limits, input('2', 'issue:2'), now + 1000, instant), { allowed: false, reason: 'concurrency-limit' });
  assert.deepEqual(store.records.map(entry => entry.admitted), [true, false], 'every launcher records its outcome');
  assert.equal((await reserveInvocationOrdered(store, limits, input('3', 'issue:2'), now + 30 * 60000, instant)).allowed, true,
    'the refused attempt does not count, so the same task runs once capacity frees');
  assert.deepEqual(await reserveInvocationOrdered(store, limits, input('4', 'issue:1'), now + 60 * 60000, instant), { allowed: false, reason: 'duplicate' });
  // Recorded outcomes stand even if the limits change: raising the limit does not revive a refused attempt as a duplicate.
  assert.equal((await reserveInvocationOrdered(store, { ...limits, maxConcurrent: 3, maxRunsPerSubject: 3 }, input('5', 'issue:2', 'edited'), now + 90 * 60000, instant)).allowed, true);
  assert.deepEqual(await reserveInvocationOrdered(store, { ...limits, enabled: false }, input('6', 'issue:6'), now, instant), { allowed: false, reason: 'disabled' });
  assert.equal(store.records.length, 5, 'a disabled policy writes nothing');
});

test('ordered admission refuses on doubt: an unsettled earlier attempt counts, and a late-visible one is caught by the second look', async () => {
  const limits = { ...fixture().limits, enabled: true, maxConcurrent: 1 };
  const input = (runId: string, subjectId: string) => ({ resource: 'example/control', subjectId, runId, attempt: 1, inputDigest: digest(subjectId), policyDigest: digest('policy') });
  const now = Date.UTC(2026, 8, 30, 12);
  const unsettled = memoryStore();
  unsettled.records.push({ position: 50, reservation: { ...input('9', 'issue:9'), schemaVersion: 1, createdAt: now, expiresAt: now + 1200000, reservedMicrousd: 1048000 } });
  assert.deepEqual(await reserveInvocationOrdered(unsettled, limits, input('1', 'issue:1'), now + 1000, instant), { allowed: false, reason: 'concurrency-limit' });
  const lagging = memoryStore();
  lagging.records.push({ position: 50, reservation: { ...input('9', 'issue:9'), schemaVersion: 1, createdAt: now, expiresAt: now + 1200000, reservedMicrousd: 1048000 } });
  lagging.hidden.add(50);
  const result = await reserveInvocationOrdered(lagging, limits, input('1', 'issue:1'), now + 1000, { sleep: async () => { lagging.hidden.clear(); } });
  assert.deepEqual(result, { allowed: false, reason: 'concurrency-limit' }, 'a record that appears only on the second look still refuses');
});

test('the GitHub admission store verifies its own issue run and orders reservations by deployment id', async () => {
  for (const fault of ['none', 'run', 'append', 'acknowledgement', 'history']) {
    const writes: unknown[] = [];
    const api: GitHubApi = { requests: 0, async request(method, path, body) {
      if (method === 'POST') {
        writes.push(body);
        if (fault === 'append') return { status: 500, requestId: null, body: {} };
        const request = body as Record<string, unknown>;
        assert.equal(request.environment, 'sample-app-reservations');
        return { status: 201, requestId: null, body: { id: 900 + writes.length, sha: control.workflowSha, creator: { login: 'github-actions[bot]' }, payload: fault === 'acknowledgement' ? {} : request.payload } };
      }
      if (path.includes('/actions/runs/')) return { status: 200, requestId: null, body: { id: 70, run_attempt: 1, status: fault === 'run' ? 'completed' : 'in_progress',
        head_sha: control.workflowSha, event: 'issues', repository: { id: 5 }, path: '.github/workflows/sample-app.yml' } };
      if (path.includes('/deployments?')) {
        if (fault === 'history') return { status: 503, requestId: null, body: [] };
        const task = new URL(`https://x${path}`).searchParams.get('task');
        return { status: 200, requestId: null, body: writes.map((write, index) => ({ id: 901 + index, ...(write as Record<string, unknown>), creator: { login: 'github-actions[bot]' } }) as Record<string, unknown>)
          .filter(entry => entry.task === task) };
      }
      throw Error(`Unexpected ${method} ${path}`);
    } };
    const operation = reserveInvocationOrdered(githubOrderedAdmissionStore(api, control, consumer), { ...fixture().limits, enabled: true }, {
      resource: control.repository, subjectId: 'issue:300', runId: '70', attempt: 1, inputDigest: digest('task'), policyDigest: digest('policy') }, Date.UTC(2026, 8, 30), instant);
    if (fault === 'none') {
      assert.equal((await operation).allowed, true);
      assert.deepEqual(writes.map(write => [(write as any).task, (write as any).payload.kind]), [['sample-app:reserve', 'sample-app-reservation'], ['sample-app:decide', 'sample-app-decision']]);
      assert.deepEqual([(writes[1] as any).payload.position, (writes[1] as any).payload.admitted], [901, true]);
    } else {
      await assert.rejects(operation, Error, fault);
      assert.equal(writes.length, fault === 'run' ? 0 : 1, fault);
    }
  }
});
