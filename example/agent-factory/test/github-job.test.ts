import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubJob, type GitHubJobOptions } from '../src/github-job.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
import type { GitHubResponse, RunnerReceipt } from '@intelligent-iterations/ii-agent-runtime';

function fixture() {
  const records = new Map<string, unknown>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  let cancelled = false;
  const commit = 'a'.repeat(40);
  const runner: RunnerReceipt = { runnerId: 42, intent: { schemaVersion: 1, repository: 'org/repo', operationId: 'id', name: 'runner', ownershipLabel: 'owned-label', groupId: 1, workFolder: '_work' } };
  const resource = { manifestPath: '/operator/manifest.json', runner };
  records.set('manifestPath', resource.manifestPath); records.set('runnerReceipt', runner);
  const context: ExecutionContext = { attemptId: 'attempt', task: {} as never, cancelled: () => cancelled,
    record: key => records.get(key) ?? null, checkpoint: (key, value) => { records.set(key, structuredClone(value)); } };
  const run = { id: 7, workflow_id: 3, head_sha: commit, display_title: 'factory-attempt', event: 'workflow_dispatch',
    run_attempt: 1, repository: { full_name: 'org/repo' }, status: 'completed', conclusion: 'success' as string | null };
  const job = { run_id: 7, head_sha: commit, status: 'completed', runner_id: 42, labels: ['self-hosted', 'owned-label'] };
  let dispatch: () => Promise<GitHubResponse> = async () => ({ status: 200, body: { workflow_run_id: 7 } });
  let inventory: unknown = { total_count: 1, workflow_runs: [run] };
  let retained = 0;
  const options: GitHubJobOptions = { repository: 'org/repo', workflowId: 3, ref: 'v1', commit, pollMs: 1, timeoutMs: 50,
    verify: async () => ({ accepted: true, evidence: { checked: true } }),
    stage: async () => {}, retain: async () => { retained++; return { retained: true }; },
    transport: { async request(method, path, body) {
      calls.push({ method, path, body });
      if (path.endsWith('/dispatches')) { assert.ok(records.has('dispatchIntent')); return dispatch(); }
      if (path.includes('/workflows/3/runs?')) return { status: 200, body: inventory };
      if (path.endsWith('/runs/7')) return { status: 200, body: run };
      if (path.includes('/jobs?')) return { status: 200, body: { total_count: 1, jobs: [job] } };
      if (path.endsWith('/cancel')) { run.status = 'completed'; run.conclusion = 'cancelled'; return { status: 202, body: null }; }
      throw Error('Unexpected request');
    } },
  };
  return { options, context, resource, records, calls, run, job, retained: () => retained,
    setDispatch(value: typeof dispatch) { dispatch = value; }, setInventory(value: unknown) { inventory = value; }, cancel() { cancelled = true; } };
}

test('dispatch records intent first, verifies exact run and runner, and retains before completion', async () => {
  const f = fixture(); const controller = createGitHubJob(f.options);
  assert.equal((await controller.run(f.context, f.resource, async () => {})).outcome, 'succeeded');
  assert.equal(f.retained(), 1);
  assert.equal(f.records.get('workflowRunId'), 7);
  assert.ok(f.records.has('workflowRetained'));
  assert.deepEqual(f.calls[0]?.body, { ref: 'v1', inputs: { attempt_id: 'attempt', runner_label: 'owned-label' } });
  await controller.reconcile(f.context);
  assert.equal(f.retained(), 1);
  await assert.rejects(controller.run(f.context, f.resource, async () => {}), /already attempted/);
  assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, 1);
});

test('dispatch binds the fixed Codex secret and rejects changed recovery configuration', async () => {
  const f = fixture();
  const setup = { schemaVersion: 1, id: 'agent-a', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/repo', key: 'CODEX_AGENT_A' }],
    capture: { paths: ['candidate.bundle'] } };
  f.context.task = { input: JSON.stringify({ role: { setup } }) } as never;
  f.options.secretName = 'CODEX_AGENT_A';
  const controller = createGitHubJob(f.options);
  assert.equal((await controller.run(f.context, f.resource, async () => {})).outcome, 'succeeded');
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/dispatches'))?.body, { ref: 'v1', inputs: {
    attempt_id: 'attempt', runner_label: 'owned-label',
  } });
  assert.equal(JSON.stringify(f.calls).includes('sk-secret-value'), false);
  setup.secrets[0]!.key = 'OTHER_CODEX_KEY';
  f.context.task = { input: JSON.stringify({ role: { setup } }) } as never;
  await assert.rejects(controller.run(f.context, f.resource, async () => {}), /already attempted/);
});

test('a fixed-secret dispatch intent remains recoverable', async () => {
  const f = fixture();
  const setup = { schemaVersion: 1, id: 'old-agent', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/repo', key: 'OLD_CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } };
  f.context.task = { input: JSON.stringify({ role: { setup } }) } as never;
  f.options.secretName = 'OLD_CODEX_KEY';
  const controller = createGitHubJob(f.options);
  await controller.run(f.context, f.resource, async () => {});
  const intent = f.records.get('dispatchIntent') as Record<string, unknown>;
  assert.equal(Object.hasOwn(intent, 'secretNames'), false);
  await controller.reconcile(f.context);
  assert.equal(f.retained(), 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/dispatches')).length, 1);
});

test('independent verification starts only after retained output and resource release', async () => {
  const f = fixture();
  const order: string[] = [];
  f.options.verify = async () => {
    assert.deepEqual(order, ['release']);
    assert.ok(f.records.has('workflowRetained'));
    order.push('verify');
    return { accepted: true, evidence: {} };
  };
  const outcome = await createGitHubJob(f.options).run(f.context, f.resource, async () => {
    assert.ok(f.records.has('workflowRetained'));
    assert.equal(f.records.has('verification'), false);
    order.push('release');
  });
  assert.equal(outcome.outcome, 'succeeded');
  assert.deepEqual(order, ['release', 'verify']);
});

test('transient worker release is retried without redispatching or repeating output retention', async () => {
  const f = fixture(); let releases = 0; let verified = 0;
  f.options.verify = async () => { verified++; assert.equal(releases, 2); return { accepted: true, evidence: {} }; };
  const result = await createGitHubJob(f.options).run(f.context, f.resource, async () => {
    releases++;
    if (releases === 1) throw Error('Temporary cleanup failure');
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(f.retained(), 1);
  assert.equal(verified, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/dispatches')).length, 1);
});

test('lost dispatch response finds the unique run and retains outputs without submitting again', async () => {
  const f = fixture(); f.setDispatch(async () => { throw Error('response lost'); });
  const controller = createGitHubJob(f.options);
  await assert.rejects(controller.run(f.context, f.resource, async () => {}), /response lost/);
  await controller.reconcile(f.context);
  assert.equal(f.records.get('workflowRunId'), 7);
  assert.equal(f.retained(), 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, 1);
});

test('absent or truncated inventory never proves a lost dispatch safe to remove', async () => {
  for (const inventory of [{ total_count: 0, workflow_runs: [] }, { total_count: 2, workflow_runs: [] }]) {
    const f = fixture(); f.setDispatch(async () => { throw Error('lost'); }); f.setInventory(inventory);
    const controller = createGitHubJob(f.options);
    await assert.rejects(controller.run(f.context, f.resource, async () => {}));
    await assert.rejects(controller.reconcile(f.context), /timed out|Incomplete|Ambiguous/);
    assert.equal(f.records.has('workflowTerminal'), false);
    assert.equal(f.retained(), 0);
  }
});

test('recovery rejects a successful run executed on the wrong runner before retaining or settling', async () => {
  const f = fixture(); f.setDispatch(async () => { throw Error('response lost'); });
  await assert.rejects(createGitHubJob(f.options).run(f.context, f.resource, async () => {}), /response lost/);
  f.job.runner_id = 99;
  await assert.rejects(createGitHubJob(f.options).reconcile(f.context), /owned runner/);
  assert.equal(f.retained(), 0);
  assert.equal(f.records.has('workflowTerminal'), false);
  assert.equal(f.calls.filter(c => c.path.endsWith('/dispatches')).length, 1);
  f.job.runner_id = 42;
  await createGitHubJob(f.options).reconcile(f.context);
  assert.equal(f.retained(), 1);
  assert.equal(f.records.has('workflowTerminal'), true);
});

test('wrong commit, repository, rerun identity or runner cannot produce success', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.run.head_sha = 'b'.repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.run.repository.full_name = 'other/repo'; },
    (f: ReturnType<typeof fixture>) => { f.run.run_attempt = 2; },
    (f: ReturnType<typeof fixture>) => { f.job.runner_id = 99; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(createGitHubJob(f.options).run(f.context, f.resource, async () => {}), /identity mismatch|owned runner/);
    assert.equal(f.records.has('workflowRetained'), false);
  }
});

test('cancellation observes terminal state after the cancellation request', async () => {
  const f = fixture(); f.run.status = 'in_progress'; f.run.conclusion = null;
  f.options.stage = async () => {};
  f.setDispatch(async () => { f.cancel(); return { status: 200, body: { workflow_run_id: 7 } }; });
  assert.equal((await createGitHubJob(f.options).run(f.context, f.resource, async () => {})).outcome, 'cancelled');
  assert.ok(f.calls.some(c => c.path.endsWith('/cancel')));
  assert.equal(f.retained(), 1);
});

test('retention failure blocks reconciliation and therefore VM deletion', async () => {
  const f = fixture(); f.options.retain = async () => { throw Error('storage unavailable'); };
  const controller = createGitHubJob(f.options);
  await assert.rejects(controller.run(f.context, f.resource, async () => {}), /storage unavailable/);
  await assert.rejects(controller.reconcile(f.context), /storage unavailable/);
  assert.equal(f.records.has('workflowTerminal'), false);
});

test('empty dispatch response waits for discovery and rejects duplicate matching runs', async () => {
  const f = fixture(); f.setDispatch(async () => ({ status: 204, body: null }));
  assert.equal((await createGitHubJob(f.options).run(f.context, f.resource, async () => {})).outcome, 'succeeded');
  const duplicate = fixture(); duplicate.setDispatch(async () => ({ status: 204, body: null }));
  duplicate.setInventory({ total_count: 2, workflow_runs: [duplicate.run, { ...duplicate.run, id: 8 }] });
  await assert.rejects(createGitHubJob(duplicate.options).run(duplicate.context, duplicate.resource, async () => {}), /Ambiguous/);
});

test('changed configuration cannot reconcile resources from a different workflow', async () => {
  const f = fixture(); f.setDispatch(async () => { throw Error('lost'); });
  await assert.rejects(createGitHubJob(f.options).run(f.context, f.resource, async () => {}));
  const before = f.calls.length;
  await assert.rejects(createGitHubJob({ ...f.options, commit: 'b'.repeat(40) }).reconcile(f.context), /configuration changed/);
  assert.equal(f.calls.length, before);
});

test('a green workflow cannot override independent task rejection', async () => {
  const f = fixture(); f.options.verify = async () => ({ accepted: false, evidence: { tests: 'failed' } });
  const job = createGitHubJob(f.options);
  assert.equal((await job.run(f.context, f.resource, async () => {})).outcome, 'failed');
  assert.deepEqual(f.records.get('verification'), { accepted: false, evidence: { tests: 'failed' } });
  await job.reconcile(f.context);
  assert.ok(f.records.has('workflowTerminal'));
});

test('outer cleanup waits for independent verification recovery even after coding outputs were retained', async () => {
  const f = fixture(); let uncertain = true; let reconciled = 0;
  f.options.recoverVerification = async () => { reconciled++; if (uncertain) throw Error('Verification VM removal unknown'); };
  const job = createGitHubJob(f.options);
  await job.run(f.context, f.resource, async () => {});
  await assert.rejects(job.reconcile(f.context), /removal unknown/);
  assert.equal(f.records.has('workflowTerminal'), false);
  uncertain = false; await job.reconcile(f.context);
  assert.equal(reconciled, 2); assert.equal(f.records.has('workflowTerminal'), true);
});

test('queued run waits for its exact resolved title without another dispatch', async () => {
  const f = fixture(); const transport = f.options.transport; let reads = 0;
  f.options.transport = { async request(method, path, body) {
    const response = await transport.request(method, path, body);
    if (path.endsWith('/runs/7') && reads++ === 0) return { status: 200, body: { ...f.run, status: 'queued', display_title: 'Factory verification' } };
    return response;
  } };
  assert.equal((await createGitHubJob(f.options).run(f.context, f.resource, async () => {})).outcome, 'succeeded');
  assert.equal(reads, 2); assert.equal(f.calls.filter(call => call.path.endsWith('/dispatches')).length, 1);
});
