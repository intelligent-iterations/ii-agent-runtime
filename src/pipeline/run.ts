import type { CompiledConfiguration } from '../runtime/configuration.js';
import { consumerNames, type ConsumerIdentity } from '../runtime/consumer.js';
import { planSetup } from './setup-plan.js';
import { ChangeRequestRefused, type ExecutionTarget, type SetupResult, type Harness, type Intake, type ModelProvider, type ModelSession, type PipelineEvent,
  type PipelineOutcome, type PipelineTask, type SourceHost, type WorkerResult } from './ports.js';

export interface PipelinePorts {
  intake: Intake;
  source: SourceHost;
  target: ExecutionTarget;
  harness: Harness;
  model: ModelProvider;
  /** Who runs the pipeline; names the task branch. */
  consumer: ConsumerIdentity;
  /** Opens the worker's gateway on the isolated network: model and code-host requests, with credentials added outside. */
  gateway(input: { address: string; grants: Awaited<ReturnType<SourceHost['workerGrants']>>; model: ModelSession; signal: AbortSignal }): Promise<{
    endpoint: string; port: number; token: string; snapshot(): unknown; close(): Promise<void> }>;
  /** Drops secrets the composition root still holds, whatever the outcome. */
  dispose(): void;
}
export interface RunOptions {
  onEvent?(event: PipelineEvent): Promise<void>;
  /** Title and body of the change request opened for pushed work; without it no change request is opened. */
  describeChange?(task: PipelineTask): { title: string; body: string };
  report?: Record<string, unknown>;
}

const SAFE_PART = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The stages every pipeline runs, whatever its adapters: authorize, admit, provision, check out, set up, grant, isolate,
 * confirm, execute, verify, deliver. Cleanup always runs in reverse order of acquisition, and each component's cleanup is reported.
 */
export async function runPipeline(compiled: CompiledConfiguration, ports: PipelinePorts, options: RunOptions = {}): Promise<PipelineOutcome> {
  const config = compiled.configuration;
  const names = consumerNames(ports.consumer);
  if (!SAFE_PART.test(ports.intake.runId)) throw Error('Invalid run identity');
  const emit = async (event: PipelineEvent) => { await options.onEvent?.(event).catch(() => undefined); };
  const cleanup: Array<{ name: string; close(): Promise<void> }> = [{ name: ports.source.name, close: () => ports.source.close() }];
  const abort = new AbortController();
  const deadline = Date.now() + config.limits.timeoutMinutes * 60000;
  const timer = setTimeout(() => abort.abort(), config.limits.timeoutMinutes * 60000);
  const interrupt = () => abort.abort();
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  const report: Record<string, unknown> = { schemaVersion: 2, runId: ports.intake.runId, attempt: ports.intake.attempt, ...options.report,
    repository: ports.source.target, artifactDigest: compiled.artifactDigest, status: 'failed', cleanup: [], workerResultVerified: false };
  let model: ModelSession | undefined;
  let gateway: Awaited<ReturnType<PipelinePorts['gateway']>> | undefined;
  let failed = true, started = false;
  const deny = async (event: PipelineEvent) => { report.status = 'denied'; await emit(event); };
  const stages = async (): Promise<void> => {
    report.phase = 'authorization';
    const authorization = await ports.intake.authorize();
    report.authorization = authorization.decision;
    if (!authorization.allowed) { await deny({ type: 'denied', reason: authorization.reason, stage: 'authorization' }); return; }
    if (!SAFE_PART.test(authorization.task.reference)) throw Error('Invalid task reference');
    const base = authorization.base;
    if (base !== undefined) report.base = base;
    if (base !== undefined && base !== authorization.defaultBranch && !await ports.source.baseExists(base)) {
      await deny({ type: 'missing-base', base }); return;
    }
    report.phase = 'admission';
    const admission = await ports.intake.admit(authorization, compiled.setupDigest, Date.now());
    report.admission = admission;
    if (!admission.allowed) { await deny({ type: 'denied', reason: admission.reason, stage: 'admission' }); return; }
    await emit({ type: 'started' });
    started = true;
    report.phase = 'provisioning';
    cleanup.splice(0, 0, { name: 'provisioner', close: () => ports.target.close() });
    const worker = await ports.target.provision(compiled);
    if (abort.signal.aborted) throw Error('Launch deadline expired');
    report.phase = 'checkout';
    const checkout = await ports.source.checkout(base);
    let plan: ReturnType<typeof planSetup>;
    try {
      await worker.load(checkout.directory);
      plan = planSetup(config.environment, checkout.directory);
    } finally { await checkout.dispose(); }
    let setup: SetupResult | undefined;
    if (plan) {
      // Internet access, and no credential anywhere in the run yet: setup ends sealed before grants are minted.
      report.phase = 'setup';
      const remaining = deadline - Date.now() - 120000;
      if (remaining < 60000) throw Error('Launch deadline expired');
      setup = { label: plan.label, ...await worker.setup(plan.commands, { timeoutMs: Math.min(plan.timeoutMs, remaining), signal: abort.signal }) };
      report.setup = setup;
    }
    report.phase = 'credentials';
    const grants = await ports.source.workerGrants();
    report.phase = 'network';
    const isolation = await worker.isolate();
    cleanup.push({ name: 'network', close: isolation.close });
    model = ports.model.open(abort.signal);
    gateway = await ports.gateway({ address: isolation.address, grants, model, signal: abort.signal });
    cleanup.push({ name: 'gateway', close: gateway.close });
    report.phase = 'final-authorization';
    const again = await ports.intake.confirm(authorization);
    report.finalAuthorization = again.decision;
    if (!again.allowed || abort.signal.aborted) throw Error('Launch authority changed');
    await isolation.connect(gateway.port);
    report.phase = 'execution';
    const branch = `${names.branchPrefix}/${again.task.reference}-run-${ports.intake.runId}`;
    const delivered = base !== undefined && options.describeChange !== undefined;
    const result: WorkerResult = await ports.harness.execute(worker, { endpoint: gateway.endpoint, token: gateway.token, task: again.task, branch,
      ...(base !== undefined ? { base } : {}), delivered, author: ports.source.author, access: ports.source.workerAccess(gateway.endpoint),
      ...(setup ? { setup } : {}), timeoutMs: deadline - Date.now(), signal: abort.signal });
    if (result.branch !== branch) throw Error('Worker reported a different branch');
    report.worker = result;
    failed = result.exitCode !== 0;
    report.status = failed ? 'failed' : 'worker-completed';
    if (base !== undefined) {
      // The worker's report is a claim; what reached the code host is checked with the run's own credential.
      const push = await ports.source.verifyPush(branch, base).catch(() => ({ verified: false as const }));
      report.push = push;
      if (push.verified && push.commits && options.describeChange) {
        if (!ports.source.canDeliver()) report.changeRequestError = 'permission';
        else report.changeRequest = await ports.source.openChangeRequest({ branch, base, ...options.describeChange(again.task) }).catch(error => {
          report.changeRequestError = 'refused';
          if (error instanceof ChangeRequestRefused) report.changeRequestRefusal = { status: error.status, reason: error.reason };
          return undefined;
        });
      }
    }
    report.phase = 'completed';
  };
  try { await stages(); }
  catch {
    if (report.status !== 'denied') {
      if (ports.intake.unreachable) await deny({ type: 'target-unreachable' });
      else report.status = abort.signal.aborted ? 'interrupted' : 'failed';
    }
  } finally {
    abort.abort(); clearTimeout(timer);
    const results: Array<{ component: string; confirmed: boolean }> = [];
    for (const component of cleanup.reverse()) {
      try { await component.close(); results.push({ component: component.name, confirmed: true }); }
      catch { failed = true; results.push({ component: component.name, confirmed: false }); }
    }
    ports.dispose();
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    report.cleanup = results;
    const usage = model?.snapshot();
    report.usage = usage ?? { generationRequests: 0, usageComplete: true };
    report.billingMode = usage?.billingMode ?? 'none';
    report.transfer = gateway?.snapshot() ?? { requests: 0, transferredBytes: 0 };
    if (usage && !usage.usageComplete) { failed = true; report.status = 'usage-incomplete'; }
    if (results.some(result => !result.confirmed)) report.status = 'cleanup-unconfirmed';
  }
  return { report, started, failed: failed && report.status !== 'denied' };
}
