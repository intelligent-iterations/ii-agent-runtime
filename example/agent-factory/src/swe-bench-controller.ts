import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseSetup, prepareSweBenchEvaluation, setupDigest, type Setup } from '@intelligent-iterations/ii-agent-runtime';
import { createTartExecutor, type TartExecutorOptions } from './tart-executor.js';
import { prepareSweBenchCandidate, sweBenchAgentRequest, type SweBenchInstance } from './swe-bench.js';
import { benchmarkScripts, createSweBenchJob, readBenchmarkEvidence, sweBenchRevision, type SweBenchDatasetArtifact, type SweBenchImage, type SweBenchManifest } from './swe-bench-job.js';
import type { ExecutionContext } from './local-coordinator.js';
import type { RetainedAttempt } from './guest-retain.js';

export interface SweBenchBenchmarkOptions extends Omit<TartExecutorOptions, 'job'> {
  setup: Setup; outputRoot: string; policyRevision: string; model: string;
  workflow: { id: number; ref: string; commit: string };
  dataset: SweBenchDatasetArtifact; timeoutSeconds: number; jobTimeoutMs?: number;
  instance(context: ExecutionContext): Promise<SweBenchInstance>;
  image(instance: SweBenchInstance): Promise<SweBenchImage>;
  baseBundle(context: ExecutionContext): Promise<{ path: string; sha256: string }>;
}
interface Snapshot { attemptId: string; configuration: string; parentInput: string; candidate: string; input: string }
export type SweBenchBenchmarkResult = { status: 'completed'; evaluatorAttemptId: string; result: ReturnType<typeof readBenchmarkEvidence> } |
  { status: 'cancelled' | 'interrupted'; evaluatorAttemptId: string | null };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Optional benchmark lifecycle. It records a native score without deciding ordinary code acceptance. */
export function createSweBenchBenchmark(options: SweBenchBenchmarkOptions, makeExecutor = createTartExecutor) {
  const setup = parseSetup(options.setup);
  if (setup.harness.name !== 'swe-bench' || setup.harness.version !== sweBenchRevision || setup.secrets.length) throw Error('Benchmark requires the pinned credential-free evaluator setup');
  const dataset = structuredClone(options.dataset); const workflow = structuredClone(options.workflow);
  if (!/^[\w.-]+\/[\w.-]+$/.test(dataset.dataset) || !/^[\w-]+$/.test(dataset.split) ||
      !/^[a-f0-9]{40}$/.test(dataset.revision) || !/^[a-f0-9]{64}$/.test(dataset.sha256) ||
      !/^[\w./-]+\.parquet$/.test(dataset.file) || dataset.file.startsWith('/') || dataset.file.split('/').some(part => !part || part === '.' || part === '..') ||
      !options.policyRevision.trim() || !Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 3600) throw Error('Invalid benchmark configuration');
  const outputRoot = realpathSync(options.outputRoot); const scripts = benchmarkScripts();
  const configuration = hash(canonicalJson({ setup: setupDigest(setup), workflow, dataset, model: options.model,
    timeoutSeconds: options.timeoutSeconds, policyRevision: options.policyRevision, scripts: hash(canonicalJson(scripts)), repository: options.repository }));
  const job = createSweBenchJob({ repository: options.repository, transport: options.transport, workflowId: workflow.id,
    ref: workflow.ref, commit: workflow.commit, outputRoot, timeoutMs: options.jobTimeoutMs ?? 3_600_000 }, scripts);
  const executor = makeExecutor({ root: options.root, binaries: options.binaries, repository: options.repository, transport: options.transport, checks: options.checks, job });
  function child(parent: ExecutionContext, snapshot: Snapshot): ExecutionContext {
    if (snapshot.configuration !== configuration || snapshot.parentInput !== hash(parent.task.input)) throw Error('Benchmark configuration or parent task changed');
    const manifest = JSON.parse(snapshot.input).benchmark as SweBenchManifest;
    if (manifest.evaluation.input.executionId !== parent.task.id || manifest.evaluation.input.attemptId !== snapshot.attemptId) throw Error('Benchmark execution binding changed');
    return { task: { ...parent.task, input: snapshot.input, digest: hash(snapshot.input) }, attemptId: snapshot.attemptId,
      cancelled: () => parent.cancelled(), record: key => parent.record('benchmark:' + key),
      checkpoint: (key, value) => parent.checkpoint('benchmark:' + key, value) };
  }
  async function finish(parent: ExecutionContext, snapshot: Snapshot, recovering: boolean): Promise<SweBenchBenchmarkResult> {
    const context = child(parent, snapshot);
    const saved = parent.record('benchmark:finished') as SweBenchBenchmarkResult | null;
    if (!saved) await (recovering ? executor.recover(context) : executor.execute(context));
    if ((context.record('manifestPath') && context.record('vmRemoved') !== true) ||
        (context.record('runnerIntent') && context.record('runnerRemoved') !== true)) throw Error('Benchmark teardown is unconfirmed');
    const retained = context.record('workflowRetained') as { conclusion: string } | null;
    let result: SweBenchBenchmarkResult;
    if (retained?.conclusion === 'success') {
      const manifest = JSON.parse(snapshot.input).benchmark as SweBenchManifest;
      result = { status: 'completed', evaluatorAttemptId: snapshot.attemptId, result: readBenchmarkEvidence(context, manifest) };
    } else result = { status: saved?.status === 'cancelled' || saved?.status === 'interrupted' ? saved.status :
      parent.cancelled() || retained?.conclusion === 'cancelled' ? 'cancelled' : 'interrupted', evaluatorAttemptId: snapshot.attemptId };
    if (saved && canonicalJson(saved) !== canonicalJson(result)) throw Error('Saved benchmark result changed');
    if (!saved) parent.checkpoint('benchmark:finished', result);
    return result;
  }
  return {
    async evaluate(parent: ExecutionContext, value: unknown): Promise<SweBenchBenchmarkResult> {
      const retained = value as RetainedAttempt;
      const candidate = retained?.worker?.candidate;
      if (!candidate || retained.worker.executionId !== parent.task.id || retained.worker.attemptId !== parent.attemptId) throw Error('Benchmark candidate execution mismatch');
      const file = retained.files.find(file => file.path === candidate.bundle);
      if (!file || file.sha256 !== candidate.sha256 || file.size !== candidate.size) throw Error('Benchmark candidate artifact mismatch');
      const stat = lstatSync(file.localPath);
      if (!stat.isFile() || stat.nlink !== 1 || realpathSync(file.localPath) !== file.localPath || stat.size !== file.size || stat.size > 64 * 1024 * 1024 || hash(readFileSync(file.localPath)) !== file.sha256) throw Error('Benchmark candidate bytes changed');
      let snapshot = parent.record('benchmark:snapshot') as Snapshot | null;
      const recovering = snapshot !== null;
      if (snapshot && snapshot.candidate !== canonicalJson(candidate)) throw Error('Benchmark candidate changed');
      if (!snapshot) {
        if (parent.cancelled()) return { status: 'cancelled', evaluatorAttemptId: null };
        const selected = await options.instance(parent);
        const instance = { instance_id: selected.instance_id, repo: selected.repo, base_commit: selected.base_commit, problem_statement: selected.problem_statement };
        sweBenchAgentRequest(instance, 'validation');
        const image = await options.image(instance);
        if (!/^[\w][\w.:/-]+@sha256:[a-f0-9]{64}$/.test(image.reference) || !['amd64', 'arm64'].includes(image.architecture) || typeof image.allowEmulation !== 'boolean') throw Error('Invalid benchmark image policy');
        const prepared = await prepareSweBenchCandidate({ context: parent, retained, instance, directory: join(outputRoot, randomUUID()),
          dataset: dataset.dataset, split: dataset.split, datasetRevision: dataset.revision, evaluatorRevision: sweBenchRevision,
          model: options.model, baseBundle: await options.baseBundle(parent) });
        const attemptId = randomUUID();
        const evaluation = prepareSweBenchEvaluation({ ...prepared.evaluation.input, attemptId });
        const benchmark: SweBenchManifest = { schemaVersion: 1, evaluation, datasetArtifact: dataset, task: instance,
          image: image.reference, architecture: image.architecture, allowEmulation: image.allowEmulation, timeoutSeconds: options.timeoutSeconds };
        snapshot = { attemptId, configuration, parentInput: hash(parent.task.input), candidate: canonicalJson(candidate), input: canonicalJson({ role: { setup }, benchmark }) };
        parent.checkpoint('benchmark:snapshot', snapshot);
      }
      return finish(parent, snapshot, recovering);
    },
    async recover(parent: ExecutionContext): Promise<SweBenchBenchmarkResult | null> {
      const snapshot = parent.record('benchmark:snapshot') as Snapshot | null;
      return snapshot ? finish(parent, snapshot, true) : null;
    },
  };
}
