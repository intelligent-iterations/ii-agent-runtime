import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, importSweBenchResult, type CapturedFile, type SweBenchEvaluation } from '@intelligent-iterations/ii-agent-runtime';
import { captureFiles } from './guest-transport.js';
import { createGitHubJob, type GitHubJobOptions } from './github-job.js';
import { createGuestStager } from './guest-stage.js';
import { installVerificationEntry } from './code-acceptance.js';
import type { ExecutionContext } from './local-coordinator.js';
import type { SweBenchInstance } from './swe-bench.js';

export const sweBenchRevision = '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e';
export interface SweBenchDatasetArtifact { dataset: string; split: string; revision: string; file: string; sha256: string }
export interface SweBenchImage { reference: string; architecture: 'amd64' | 'arm64'; allowEmulation: boolean }
export interface SweBenchManifest {
  schemaVersion: 1; evaluation: SweBenchEvaluation; datasetArtifact: SweBenchDatasetArtifact;
  task: SweBenchInstance; image: string; architecture: 'amd64' | 'arm64'; allowEmulation: boolean; timeoutSeconds: number;
}
interface Evidence { files: CapturedFile[]; receipt: unknown | null }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function benchmarkScripts() {
  return { 'evaluate.py': readFileSync(new URL('../evaluators/swe-bench/run.py', import.meta.url)).toString('base64'),
    'entry.sh': readFileSync(new URL('../evaluators/swe-bench/entry.sh', import.meta.url)).toString('base64'),
    'verify.sh': Buffer.from('#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root /bin/sh /opt/factory/workload/entry.sh\n').toString('base64') };
}
function retainedBytes(file: CapturedFile) {
  const stat = lstatSync(file.localPath);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(file.localPath) !== file.localPath || stat.size !== file.size || stat.size > 64 * 1024 * 1024) throw Error('Invalid retained benchmark file');
  const bytes = readFileSync(file.localPath);
  if (hash(bytes) !== file.sha256) throw Error('Retained benchmark bytes changed');
  return bytes;
}
/** Revalidate durable files on every replay; an imported receipt alone is insufficient. */
export function readBenchmarkEvidence(context: ExecutionContext, manifest: SweBenchManifest) {
  const evidence = context.record('evidence') as Evidence | null;
  if (!evidence) throw Error('Missing benchmark evidence');
  const files = new Map<string, Buffer>();
  for (const file of evidence.files) {
    if (files.has(file.path)) throw Error('Duplicate benchmark evidence');
    files.set(file.path, retainedBytes(file));
  }
  const parse = (path: string) => { const bytes = files.get(path); if (!bytes) throw Error('Missing benchmark output'); return JSON.parse(bytes.toString('utf8')); };
  const receipt = parse('receipt.json');
  if (canonicalJson(receipt) !== canonicalJson(evidence.receipt) || receipt.containerRemoved !== true ||
      receipt.datasetSha256 !== manifest.datasetArtifact.sha256 || receipt.image !== manifest.image ||
      receipt.architecture !== manifest.architecture || !['amd64', 'arm64'].includes(receipt.hostArchitecture) ||
      (!manifest.allowEmulation && receipt.hostArchitecture !== manifest.architecture) || !/^sha256:[a-f0-9]{64}$/.test(receipt.imageId)) throw Error('Benchmark receipt binding mismatch');
  const log = files.get('test-output.txt');
  if (!log || hash(log) !== receipt.testOutputSha256 || canonicalJson(parse('native-report.json')) !== canonicalJson(receipt.report)) throw Error('Benchmark native output mismatch');
  return importSweBenchResult(manifest.evaluation, receipt);
}
export function createSweBenchJob(options: Pick<GitHubJobOptions, 'transport' | 'repository' | 'workflowId' | 'ref' | 'commit'> & { outputRoot: string; timeoutMs: number }, scripts: ReturnType<typeof benchmarkScripts>) {
  return createGitHubJob({ ...options,
    async stage(context, resource) {
      const manifest = JSON.parse(context.task.input).benchmark as SweBenchManifest;
      const files = { ...scripts, 'manifest.json': Buffer.from(canonicalJson(manifest)).toString('base64') };
      await createGuestStager({ files, sha256: hash(canonicalJson(files)) }, options.commit)(context, resource);
      await installVerificationEntry(resource.manifestPath);
    },
    async retain(context, resource, run) {
      const saved = context.record('evidence'); if (saved) return saved;
      const destination = join(options.outputRoot, randomUUID()); mkdirSync(destination, { mode: 0o700 });
      const paths = ['receipt.json', 'execution.log', 'test-output.txt', 'native-report.json', 'native-instance.log'];
      const files = await captureFiles(resource.manifestPath, { root: '/opt/factory/benchmark-results', paths, destination,
        ...(run.conclusion === 'success' ? {} : { optionalPaths: paths }) });
      const receipt = files.find(file => file.path === 'receipt.json');
      const evidence: Evidence = { files, receipt: receipt ? JSON.parse(retainedBytes(receipt).toString('utf8')) : null };
      context.checkpoint('evidence', evidence); return evidence;
    },
    async verify(context) {
      const manifest = JSON.parse(context.task.input).benchmark as SweBenchManifest;
      return { accepted: true, evidence: readBenchmarkEvidence(context, manifest) };
    },
  });
}
