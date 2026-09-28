import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readSqliteTelemetryEvents, setupDigest, parseSetup, type CapturedFile } from '@intelligent-iterations/ii-agent-runtime';
import { captureFiles } from './guest-transport.js';
import type { ExecutionContext } from './local-coordinator.js';
import type { WorkerResult } from './worker.js';

export interface RetainedAttempt { worker: WorkerResult; files: CapturedFile[] }
export interface InterruptedAttempt {
  interrupted: true; conclusion: string | null; files: CapturedFile[];
  missingMetadata: string[]; outputGaps: string[]; sealedManifest: boolean;
}
/** Factory interpretation of worker outputs; the runtime owns byte transfer and durable capture. */
export function createGuestRetainer(root: string, capture = captureFiles) {
  const parent = realpathSync(root);
  return async (context: ExecutionContext, resource: { manifestPath: string }, run: { conclusion: string | null }): Promise<RetainedAttempt | InterruptedAttempt> => {
    const previous = context.record('retainedAttempt') as RetainedAttempt | InterruptedAttempt | null;
    if (previous) {
      for (const file of previous.files) {
        const bytes = readFileSync(file.localPath);
        if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Previously retained evidence changed');
      }
      return previous;
    }
    const input = JSON.parse(context.task.input);
    const setup = parseSetup(input.role.setup);
    const staging = context.record('workerStaging') as { workloadDigest?: string } | null;
    const directory = join(parent, randomUUID()); mkdirSync(directory, { mode: 0o700 });
    if (run.conclusion !== 'success') {
      const paths = ['result.json', 'telemetry.sqlite', 'telemetry.sqlite-wal', 'telemetry.sqlite-shm'];
      const metadata = await capture(resource.manifestPath, { root: '/results/attempt', paths, optionalPaths: paths, destination: directory });
      const resultFile = metadata.find(file => file.path === 'result.json');
      let result: WorkerResult | undefined;
      try {
        const value = resultFile ? JSON.parse(readFileSync(resultFile.localPath, 'utf8')) : undefined;
        if (value?.schemaVersion === 1 && value.executionId === context.task.id && value.attemptId === context.attemptId && (!staging?.workloadDigest || value.workloadDigest === staging.workloadDigest) && Array.isArray(value.artifacts) &&
            new Set(value.artifacts.map((file: { path: string }) => file.path)).size === value.artifacts.length && value.artifacts.every((file: { path: string; size: number; sha256: string }) =>
              setup.capture.paths.includes(file.path) && Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256))) result = value;
      } catch { /* Retain malformed terminal metadata as evidence; it cannot authorize output capture. */ }
      const sealed = result?.artifacts.map(file => file.path) ?? [];
      // Unsealed workspace bytes have not passed the worker's credential exclusion filter.
      const outputs = sealed.length ? await capture(resource.manifestPath, { root: '/results/attempt/workspace', paths: sealed, optionalPaths: sealed, destination: directory }) : [];
      for (const file of outputs) {
        const expected = result!.artifacts.find(item => item.path === file.path)!;
        if (file.size !== expected.size || file.sha256 !== expected.sha256) throw Error('Interrupted output changed after sealing');
      }
      const retained: InterruptedAttempt = { interrupted: true, conclusion: run.conclusion, files: [...metadata, ...outputs],
        missingMetadata: paths.filter(path => !metadata.some(file => file.path === path)),
        outputGaps: setup.capture.paths.filter(path => !outputs.some(file => file.path === path)), sealedManifest: !!result };
      context.checkpoint('retainedAttempt', retained); return retained;
    }
    const metadata = await capture(resource.manifestPath, { root: '/results/attempt', paths: ['result.json', 'telemetry.sqlite'], destination: directory });
    const resultFile = metadata.find(file => file.path === 'result.json');
    if (!resultFile) throw Error('Worker result missing');
    const result: WorkerResult = JSON.parse(readFileSync(resultFile.localPath, 'utf8'));
    if (result.schemaVersion !== 1 || result.executionId !== context.task.id || result.attemptId !== context.attemptId || (staging?.workloadDigest && result.workloadDigest !== staging.workloadDigest) ||
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(result.state) || !Array.isArray(result.artifacts) || !Array.isArray(result.outputGaps)) throw Error('Worker result identity mismatch');
    if (run.conclusion === 'success' && (result.state !== 'completed' || result.telemetryComplete !== true || result.observedUsage !== true || result.outputGaps.length !== 0)) throw Error('Successful job lacks complete worker evidence');
    const telemetry = metadata.find(file => file.path === 'telemetry.sqlite');
    if (!telemetry) throw Error('Telemetry artifact missing');
    const events = readSqliteTelemetryEvents(telemetry.localPath, 100_000);
    if (!events.length || events.length === 100_000 || events.some(event => {
      const binding = (event.payload as { runtime?: { executionId?: string; attemptId?: string; setupDigest?: string } }).runtime;
      return binding?.executionId !== context.task.id || binding.attemptId !== context.attemptId || binding.setupDigest !== setupDigest(setup);
    })) throw Error('Telemetry correlation mismatch or incomplete inventory');
    if (run.conclusion === 'success' && (!events.some(event => event.eventType === 'worker.finished') || !events.some(event => {
      const data = (event.payload as { data?: { type?: string; usage?: Record<string, unknown> } }).data;
      return data?.type === 'turn.completed' && data.usage && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(data.usage![key]) && (data.usage![key] as number) >= 0);
    }))) throw Error('Terminal telemetry or usage missing');
    const declared = new Set(setup.capture.paths);
    const seen = new Set<string>();
    for (const file of result.artifacts) {
      if (!declared.has(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid output manifest');
      seen.add(file.path);
    }
    if (run.conclusion === 'success' && seen.size !== declared.size) throw Error('Required outputs are missing');
    const outputs = seen.size ? await capture(resource.manifestPath, { root: '/results/attempt/workspace', paths: [...seen], destination: directory }) : [];
    for (const expected of result.artifacts) {
      const actual = outputs.find(file => file.path === expected.path);
      if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) throw Error('Output changed after worker sealing');
    }
    if (run.conclusion === 'success' && input.role.kind === 'code') {
      const candidate = result.candidate;
      const bundle = outputs.find(file => file.path === 'candidate.bundle');
      if (!candidate || candidate.baseCommit !== input.baseCommit || candidate.bundle !== 'candidate.bundle' ||
          !/^[a-f0-9]{40}$/.test(candidate.commit) || !/^[a-f0-9]{40}$/.test(candidate.tree) ||
          !bundle || candidate.sha256 !== bundle.sha256 || candidate.size !== bundle.size) throw Error('Code candidate evidence mismatch');
    }
    const retained = { worker: result, files: [...metadata, ...outputs] };
    context.checkpoint('retainedAttempt', retained);
    return retained;
  };
}
