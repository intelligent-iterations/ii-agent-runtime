import { createHash } from 'node:crypto';
import { canonicalJson } from './setup.js';

export interface SweBenchInput {
  executionId: string; attemptId: string; setupDigest: string;
  dataset: string; split: string; datasetRevision: string; evaluatorRevision: string;
  instanceId: string; model: string; patch: string;
}
export interface SweBenchEvaluation {
  input: SweBenchInput; runId: string; predictionsJsonl: string; predictionsSha256: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value) && !value.includes('..');
/** Native data only. The caller installs the pinned evaluator and owns its execution environment. */
export function prepareSweBenchEvaluation(value: SweBenchInput): SweBenchEvaluation {
  const { executionId, attemptId, setupDigest, dataset, split, datasetRevision, evaluatorRevision, instanceId, model, patch } = value;
  if (![executionId, attemptId, dataset, split, instanceId, model].every(identifier) ||
      !/^sha256:[a-f0-9]{64}$/.test(setupDigest) || !/^[a-f0-9]{40}$/.test(datasetRevision) || !/^[a-f0-9]{40}$/.test(evaluatorRevision) ||
      typeof patch !== 'string' || patch.includes('\0') || Buffer.byteLength(patch) > 4 * 1024 * 1024) throw Error('Invalid SWE-bench input');
  const input = { executionId, attemptId, setupDigest, dataset, split, datasetRevision, evaluatorRevision, instanceId, model, patch };
  const predictionsJsonl = canonicalJson({ instance_id: instanceId, model_name_or_path: model, model_patch: patch }) + '\n';
  return { input, predictionsJsonl, predictionsSha256: hash(predictionsJsonl), runId: 'runtime-' + hash(canonicalJson(input)) };
}

/** The runner binds a retained native per-instance report to the invocation it actually executed. */
export function importSweBenchResult(evaluation: SweBenchEvaluation, evidence: {
  runId: string; predictionsSha256: string; evaluatorRevision: string; datasetRevision: string; report: unknown;
}) {
  const expected = prepareSweBenchEvaluation(evaluation.input);
  if (canonicalJson(expected) !== canonicalJson(evaluation) || evidence.runId !== expected.runId ||
      evidence.predictionsSha256 !== expected.predictionsSha256 || evidence.evaluatorRevision !== expected.input.evaluatorRevision ||
      evidence.datasetRevision !== expected.input.datasetRevision) throw Error('SWE-bench result binding mismatch');
  const encoded = canonicalJson(evidence.report);
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw Error('SWE-bench report exceeds limit');
  const report = JSON.parse(encoded);
  if (!report || Array.isArray(report) || typeof report !== 'object' || Object.keys(report).length !== 1 || !Object.hasOwn(report, expected.input.instanceId)) throw Error('SWE-bench result instance mismatch');
  const native = report[expected.input.instanceId];
  if (!native || typeof native !== 'object' || Array.isArray(native) ||
      ['patch_is_None', 'patch_exists', 'patch_successfully_applied', 'resolved', 'infra_failure'].some(key => typeof native[key] !== 'boolean') ||
      native.patch_is_None || !native.patch_exists || (native.resolved && (!native.patch_successfully_applied || native.infra_failure))) throw Error('Invalid SWE-bench native report');
  return { executionId: expected.input.executionId, attemptId: expected.input.attemptId, setupDigest: expected.input.setupDigest,
    runId: expected.runId, instanceId: expected.input.instanceId,
    outcome: native.infra_failure ? 'infrastructure_failure' as const : native.resolved ? 'resolved' as const : 'unresolved' as const,
    reportSha256: hash(encoded), nativeReport: report };
}
