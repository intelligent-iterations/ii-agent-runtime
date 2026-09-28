import { parseSetup, type GitHubTransport, type RunnerReceipt } from '@intelligent-iterations/ii-agent-runtime';
import type { ExecutionContext } from './local-coordinator.js';
import type { FactoryJob } from './tart-executor.js';

type Resource = { manifestPath: string; runner: RunnerReceipt };
interface DispatchIntent {
  repository: string; workflowId: number; ref: string; commit: string;
  title: string; runnerId: number; runnerLabel: string;
}
interface Run { id: number; status: string; conclusion: string | null }
export interface GitHubJobOptions {
  transport: GitHubTransport;
  repository: string;
  workflowId: number;
  ref: string;
  commit: string;
  /** Fixed secret name baked into the installed worker workflow. Omit for verification. */
  secretName?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Stage trusted worker code and task input inside this guest before dispatch. */
  stage(context: ExecutionContext, resource: Resource): Promise<void>;
  beforeDispatch?(context: ExecutionContext): Promise<void>;
  /** Copy and verify outputs on operator storage; returning a path alone is insufficient. */
  retain(context: ExecutionContext, resource: Resource, run: Run): Promise<unknown>;
  /** Host-side publication after retention; never runs in the worker VM. */
  publish?(context: ExecutionContext, retained: unknown): Promise<unknown>;
  /** Independent task acceptance runs against retained evidence, never a harness self-assessment. */
  /** Reconcile a separately allocated verification attempt before outer cleanup. */
  recoverVerification?(context: ExecutionContext): Promise<void>;
  verify(context: ExecutionContext, retained: unknown): Promise<{ accepted: boolean; evidence: unknown }>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Actions response');
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

/** Factory dispatch policy, using runtime's consumer-authenticated GitHub transport. */
export function createGitHubJob(options: GitHubJobOptions): FactoryJob {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(options.repository) || !positive(options.workflowId) ||
      !/^[a-f0-9]{40}$/.test(options.commit) || !options.ref.trim()) throw Error('Invalid workflow configuration');
  const timeoutMs = options.timeoutMs ?? 3_600_000;
  const pollMs = options.pollMs ?? 2_000;
  if (!positive(timeoutMs) || !positive(pollMs)) throw Error('Invalid Actions polling limits');
  const base = `/repos/${options.repository}/actions`;
  const pause = () => new Promise(resolve => setTimeout(resolve, pollMs));
  function verify(value: unknown, intent: DispatchIntent): Run | null {
    const item = object(value);
    const mismatches = [
      ['id', positive(item.id)], ['workflow', item.workflow_id === intent.workflowId], ['commit', item.head_sha === intent.commit],
      ['event', item.event === 'workflow_dispatch'], ['attempt', item.run_attempt === 1],
      ['repository', object(item.repository).full_name === intent.repository], ['status', typeof item.status === 'string'],
      ['conclusion', item.conclusion === null || typeof item.conclusion === 'string'],
    ].filter(([, matched]) => !matched).map(([field]) => field);
    if (mismatches.length) throw Error('Workflow run identity mismatch: ' + mismatches.join(','));
    // A queued run without its exact title remains unverified. Wait within the
    // existing deadline; never accept a placeholder or redispatch.
    if (item.display_title !== intent.title) {
      if (item.status === 'queued') return null;
      throw Error('Workflow run identity mismatch: title');
    }
    return { id: item.id as number, status: item.status as string, conclusion: item.conclusion as string | null };
  }
  async function read(id: number, intent: DispatchIntent): Promise<Run | null> {
    const response = await options.transport.request('GET', `${base}/runs/${id}`);
    if (response.status !== 200) throw Error('Workflow run observation unavailable');
    const run = verify(response.body, intent);
    if (!run) return null;
    if (run.id !== id) throw Error('Workflow run identity mismatch');
    return run;
  }
  async function discover(intent: DispatchIntent): Promise<Run | null> {
    const seen = new Set<number>();
    let expected: number | undefined;
    const matches: Run[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await options.transport.request('GET', `${base}/workflows/${intent.workflowId}/runs?event=workflow_dispatch&head_sha=${intent.commit}&per_page=100&page=${page}`);
      if (response.status !== 200) throw Error('Dispatch reconciliation unavailable');
      const body = object(response.body);
      if (!Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0 || !Array.isArray(body.workflow_runs) ||
          (expected !== undefined && expected !== body.total_count)) throw Error('Incomplete run inventory');
      expected = body.total_count as number;
      for (const value of body.workflow_runs) {
        const item = object(value);
        if (!positive(item.id) || seen.has(item.id)) throw Error('Ambiguous run inventory');
        seen.add(item.id);
        if (item.display_title === intent.title) { const verified = verify(item, intent); if (verified) matches.push(verified); }
      }
      if (body.workflow_runs.length < 100) {
        if (seen.size !== expected || matches.length > 1) throw Error('Ambiguous run inventory');
        return matches[0] ?? null;
      }
    }
    throw Error('Run inventory exceeds reconciliation limit');
  }
  async function resolve(context: ExecutionContext, intent: DispatchIntent): Promise<Run | null> {
    const id = context.record('workflowRunId');
    if (positive(id)) return read(id, intent);
    const run = await discover(intent);
    // Absence does not prove that a dispatch with a lost response was rejected.
    if (!run) return null;
    context.checkpoint('workflowRunId', run.id);
    return run;
  }
  async function verifyRunner(run: Run, intent: DispatchIntent): Promise<void> {
    const response = await options.transport.request('GET', `${base}/runs/${run.id}/jobs?filter=all&per_page=100`);
    if (response.status !== 200) throw Error('Job assignment unavailable');
    const body = object(response.body);
    if (body.total_count !== 1 || !Array.isArray(body.jobs) || body.jobs.length !== 1) throw Error('Expected exactly one factory job');
    const job = object(body.jobs[0]);
    if (job.run_id !== run.id || job.head_sha !== intent.commit || job.status !== 'completed' ||
        job.runner_id !== intent.runnerId || !Array.isArray(job.labels) || !job.labels.includes(intent.runnerLabel)) {
      throw Error('Job did not execute on the owned runner');
    }
  }
  async function wait(context: ExecutionContext, intent: DispatchIntent, cancelling: boolean): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    let cancelSent = false;
    while (Date.now() < deadline) {
      const run = await resolve(context, intent);
      if (!run) { await pause(); continue; }
      if (run.status === 'completed') return run;
      if ((cancelling || context.cancelled()) && !cancelSent) {
        // Cancellation is safely repeatable; a lost response is reconciled by reading the same run.
        const response = await options.transport.request('POST', `${base}/runs/${run.id}/cancel`);
        if (![202, 409].includes(response.status)) throw Error('Workflow cancellation unconfirmed');
        cancelSent = true;
      }
      await pause();
    }
    throw Error('Workflow wait timed out; retain resources for recovery');
  }
  function savedIntent(context: ExecutionContext): DispatchIntent | null {
    const value = context.record('dispatchIntent') as DispatchIntent | null;
    if (value && (value.repository !== options.repository || value.workflowId !== options.workflowId || value.commit !== options.commit ||
        value.ref !== options.ref || value.title !== `factory-${context.attemptId}` || !positive(value.runnerId) || typeof value.runnerLabel !== 'string')) {
      throw Error('Dispatch configuration changed; recover with original configuration');
    }
    return value;
  }
  function checkSecrets(context: ExecutionContext): void {
    const input = JSON.parse(context.task.input ?? '{}') as { role?: { setup?: unknown } };
    if (!input.role?.setup) return;
    const secrets = parseSetup(input.role?.setup).secrets;
    if (secrets.length !== (options.secretName ? 1 : 0) || secrets.some(secret => secret.key !== options.secretName ||
        secret.repository !== options.repository || secret.organization !== undefined || secret.environment !== undefined))
      throw Error('Worker secret binding differs from installed workflow');
  }
  return {
    async run(context, resource, release) {
      if (savedIntent(context)) throw Error('Dispatch already attempted; reconcile instead of resubmitting');
      if (resource.runner.intent.repository !== options.repository) throw Error('Runner repository mismatch');
      checkSecrets(context);
      await options.stage(context, resource);
      if (context.cancelled()) return { outcome: 'cancelled', result: { reason: 'cancelled_before_dispatch' } };
      await options.beforeDispatch?.(context);
      const intent: DispatchIntent = { repository: options.repository, workflowId: options.workflowId, ref: options.ref, commit: options.commit,
        title: `factory-${context.attemptId}`, runnerId: resource.runner.runnerId, runnerLabel: resource.runner.intent.ownershipLabel };
      context.checkpoint('dispatchIntent', intent);
      const response = await options.transport.request('POST', `${base}/workflows/${options.workflowId}/dispatches`, {
        ref: intent.ref, inputs: { attempt_id: context.attemptId, runner_label: intent.runnerLabel },
      });
      if (response.status === 200) {
        const id = object(response.body).workflow_run_id;
        if (!positive(id)) throw Error('Missing dispatched run identity');
        context.checkpoint('workflowRunId', id);
      } else if (response.status !== 204) {
        throw Error('Workflow dispatch unconfirmed');
      }
      const run = await wait(context, intent, false);
      if (run.conclusion === 'success') await verifyRunner(run, intent);
      const retained = await options.retain(context, resource, run);
      context.checkpoint('workflowRetained', { runId: run.id, conclusion: run.conclusion, result: retained });
      const publication = run.conclusion === 'success' ? await options.publish?.(context, retained) : undefined;
      // Acceptance uses retained bytes, so release the worker VM and its private
      // image cache before allocating an independent verification VM.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await release(); break; }
        catch {
          if (attempt === 2) throw Error('Worker resource release unconfirmed');
          await pause();
        }
      }
      const verification = run.conclusion === 'success' ? await options.verify(context, retained) : { accepted: false, evidence: { reason: 'workflow_not_successful' } };
      context.checkpoint('verification', verification);
      return { outcome: context.cancelled() || run.conclusion === 'cancelled' ? 'cancelled' : verification.accepted ? 'succeeded' : 'failed', result: { retained, publication, verification } };
    },
    async reconcile(context) {
      const intent = savedIntent(context);
      if (!intent) return;
      const run = await wait(context, intent, true);
      // A completed run discovered after a lost response must meet the same
      // runner-ownership check as the uninterrupted execution path.
      if (run.conclusion === 'success') await verifyRunner(run, intent);
      if (!context.record('workflowRetained')) {
        const manifestPath = context.record('manifestPath');
        const runner = context.record('runnerReceipt') as RunnerReceipt | null;
        if (typeof manifestPath !== 'string' || !runner) throw Error('Missing output retention resource identity');
        const retained = await options.retain(context, { manifestPath, runner }, run);
        context.checkpoint('workflowRetained', { runId: run.id, conclusion: run.conclusion, result: retained });
      }
      const retained = context.record('workflowRetained') as { result: unknown; conclusion: string | null } | null;
      if (retained?.conclusion === 'success') await options.publish?.(context, retained.result);
      await options.recoverVerification?.(context);
      context.checkpoint('workflowTerminal', { runId: run.id, conclusion: run.conclusion });
    },
  };
}
