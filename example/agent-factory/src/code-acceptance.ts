import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseSetup, setupDigest, type Setup, type CapturedFile, type LibvirtManifest } from '@intelligent-iterations/ii-agent-runtime';
import { captureFiles, executeGuest } from './guest-transport.js';
import { createTartExecutor, createLibvirtExecutor, type TartExecutorOptions } from './tart-executor.js';
import { createGitHubJob } from './github-job.js';
import { buildWorkerBundle, createGuestStager } from './guest-stage.js';
import type { ExecutionContext, AttemptExecutor } from './local-coordinator.js';
import type { RetainedAttempt } from './guest-retain.js';
import { validateAcceptanceChecks, type AcceptanceCheck, type CodeVerificationInput, type CodeVerificationResult } from './code-verifier.js';

type Outcome = Awaited<ReturnType<AttemptExecutor>>;
interface Snapshot { attemptId: string; input: string; configuration: string }
interface Evidence { result: CodeVerificationResult; file: CapturedFile }
export interface CodeAcceptanceOptions extends Omit<TartExecutorOptions, 'job' | 'binaries'> {
  binaries: TartExecutorOptions['binaries'] | LibvirtManifest['binaries'];
  setup: Setup;
  /** Choose a credential-free verification setup for each approved workload profile. */
  setupFor?(context: ExecutionContext): Setup;
  outputRoot: string;
  jobTimeoutMs?: number;
  workflow: { id: number; ref: string; commit: string };
  policy(context: ExecutionContext): Promise<AcceptanceCheck[]>;
  /** Trusted base acquired independently of the coding agent. No credential bytes. */
  baseBundle(context: ExecutionContext): Promise<{ path: string; sha256: string }>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function bytes(path: string, digest: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path || stat.size > 64 * 1024 * 1024) throw Error('Invalid retained verification input');
  const data = readFileSync(path); if (hash(data) !== digest) throw Error('Retained verification input changed'); return data;
}
/** Install only the fixed, root-owned verification command in this dedicated guest. */
export async function installVerificationEntry(manifestPath: string): Promise<void> {
      await executeGuest(manifestPath, ['sudo', '-n', 'python3', '-c',
        "import os,subprocess\np='/etc/sudoers.d/factory-verification'\nf=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o440)\nwith os.fdopen(f,'w') as out: out.write('agent ALL=(root) NOPASSWD: /bin/sh /opt/factory/workload/verify.sh\\n');out.flush();os.fsync(out.fileno())\nsubprocess.run(['/usr/sbin/visudo','-cf',p],check=True)\n"]);
}

/** Factory-only composition: one independently owned VM/runner/job for the coding acceptance attempt. */
export function createCodeAcceptance(options: CodeAcceptanceOptions, makeExecutor = createTartExecutor) {
  const setup = parseSetup(options.setup);
  if (setup.harness.name !== 'verification' || setup.secrets.length) throw Error('Verification requires a credential-free setup');
  const workflow = structuredClone(options.workflow); const bundle = buildWorkerBundle();
  const outputRoot = realpathSync(options.outputRoot);
  function selectedSetup(parent: ExecutionContext): Setup {
    const selected = options.setupFor ? parseSetup(options.setupFor(parent)) : setup;
    if (selected.harness.name !== 'verification' || selected.secrets.length) throw Error('Verification requires a credential-free setup');
    if (selected.deployment.provider !== setup.deployment.provider) throw Error('Verification VM provider changed');
    return selected;
  }
  function configuration(parent: ExecutionContext): string {
    return hash(canonicalJson({ setup: setupDigest(selectedSetup(parent)), workflow, repository: options.repository, bundle: bundle.sha256 }));
  }
  function child(parent: ExecutionContext, snapshot: Snapshot): ExecutionContext {
    if (snapshot.configuration !== configuration(parent)) throw Error('Verification configuration changed; recover with the original configuration');
    return { attemptId: snapshot.attemptId, task: { ...parent.task, input: snapshot.input, digest: hash(snapshot.input) },
      cancelled: () => parent.cancelled(), record: key => parent.record('verification:' + key),
      checkpoint: (key, value) => parent.checkpoint('verification:' + key, value) };
  }
  const job = createGitHubJob({ transport: options.transport, repository: options.repository,
    workflowId: workflow.id, ref: workflow.ref, commit: workflow.commit,
    ...(options.jobTimeoutMs === undefined ? {} : { timeoutMs: options.jobTimeoutMs }),
    async stage(context, resource) {
      const input = JSON.parse(context.task.input);
      const files = { ...bundle.files,
        'verification/base.bundle': bytes(input.baseBundle.path, input.baseBundle.sha256).toString('base64'),
        'verification/candidate.bundle': bytes(input.candidateFile.localPath, input.candidateFile.sha256).toString('base64'),
        'verify.sh': Buffer.from('#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /opt/factory/workload/dist/verification-entry.js\n').toString('base64') };
      await createGuestStager({ files, sha256: hash(canonicalJson(files)) }, workflow.commit)(context, resource);
      await installVerificationEntry(resource.manifestPath);
      context.checkpoint('verificationEntryReady', true);
    },
    async retain(context, resource, run) {
      const input = JSON.parse(context.task.input);
      const expected = input.verification as CodeVerificationInput;
      let evidence = context.record('codeEvidence') as Evidence | null;
      if (!evidence) {
        const directory = join(outputRoot, randomUUID()); mkdirSync(directory, { mode: 0o700 });
        const paths = ['verification.json'];
        const files = await captureFiles(resource.manifestPath, { root: '/opt/factory/verified', paths, destination: directory,
          ...(run.conclusion === 'success' ? {} : { optionalPaths: paths }) });
        const file = files[0];
        if (!file) {
          const incomplete = { incomplete: true, conclusion: run.conclusion, missing: paths };
          context.checkpoint('codeFailureEvidence', incomplete); return incomplete;
        }
        evidence = { result: JSON.parse(bytes(file.localPath, file.sha256).toString('utf8')), file };
      }
      const result: CodeVerificationResult = JSON.parse(bytes(evidence.file.localPath, evidence.file.sha256).toString('utf8'));
      if (canonicalJson(result) !== canonicalJson(evidence.result) || result.schemaVersion !== 1 || result.executionId !== context.task.id || result.attemptId !== context.attemptId ||
          result.commit !== expected.candidate.commit || result.baseCommit !== expected.candidate.baseCommit || result.tree !== expected.candidate.tree ||
          result.bundleSha256 !== expected.candidate.sha256 || result.policySha256 !== hash(canonicalJson(expected.checks)) ||
          typeof result.accepted !== 'boolean' || !Array.isArray(result.checks) || result.checks.length !== expected.checks.length) throw Error('Verification evidence binding mismatch');
      const passed = result.checks.every((check, index) => {
        const policy = expected.checks[index]!;
        if (check.id !== policy.id || typeof check.passed !== 'boolean') throw Error('Verification check mismatch');
        return check.passed && check.exitCode === 0 && check.reason === 'exit' && /^[a-f0-9]{64}$/.test(check.stdoutSha256) &&
          (policy.stdoutSha256 === undefined || check.stdoutSha256 === policy.stdoutSha256);
      });
      if (result.accepted !== passed) throw Error('Verification acceptance mismatch');
      context.checkpoint('codeEvidence', evidence); return evidence;
    },
    async verify(_context, retained) {
      const evidence = retained as Evidence; return { accepted: evidence.result.accepted, evidence };
    },
  });
  const infrastructure = { root: options.root, repository: options.repository, transport: options.transport,
    checks: options.checks, ...(options.runner ? { runner: options.runner } : {}), job };
  if (makeExecutor === createTartExecutor &&
      !((setup.deployment.provider === 'tart' && 'tart' in options.binaries) ||
        (setup.deployment.provider === 'libvirt' && 'virsh' in options.binaries))) throw Error('Verification host tools do not match VM provider');
  const executor = setup.deployment.provider === 'libvirt' && makeExecutor === createTartExecutor && 'virsh' in options.binaries
    ? createLibvirtExecutor({ ...infrastructure, binaries: options.binaries })
    : makeExecutor({ ...infrastructure, binaries: options.binaries as TartExecutorOptions['binaries'] });
  async function finish(parent: ExecutionContext, snapshot: Snapshot, recover: boolean): Promise<Outcome> {
    const context = child(parent, snapshot);
    const previous = parent.record('verification:finished') as Outcome | null;
    if (previous) {
      const evidence = context.record('codeEvidence') as Evidence | null;
      if (evidence) bytes(evidence.file.localPath, evidence.file.sha256);
      return previous;
    }
    const outcome = await (recover ? executor.recover(context) : executor.execute(context));
    parent.checkpoint('verification:finished', outcome); return outcome;
  }
  return {
    async verify(parent: ExecutionContext, value: unknown) {
      const retained = value as RetainedAttempt;
      const task = JSON.parse(parent.task.input);
      if (task.role.kind !== 'code' || !retained?.worker?.candidate || retained.worker.candidate.baseCommit !== task.baseCommit) throw Error('Expected a retained code candidate');
      if (retained.worker.executionId !== parent.task.id || retained.worker.attemptId !== parent.attemptId) throw Error('Code candidate execution identity mismatch');
      let snapshot = parent.record('verification:snapshot') as Snapshot | null;
      const recovering = snapshot !== null;
      if (snapshot && canonicalJson(JSON.parse(snapshot.input).verification.candidate) !== canonicalJson(retained.worker.candidate)) throw Error('Verification candidate changed');
      if (!snapshot) {
        const candidate = structuredClone(retained.worker.candidate);
        const candidateFile = retained.files.find(file => file.path === candidate.bundle);
        if (!candidateFile || candidateFile.sha256 !== candidate.sha256 || candidateFile.size !== candidate.size) throw Error('Candidate artifact mismatch');
        bytes(candidateFile.localPath, candidate.sha256);
        const baseBundle = await options.baseBundle(parent); bytes(baseBundle.path, baseBundle.sha256);
        const checks = await options.policy(parent);
        validateAcceptanceChecks(checks);
        const attemptId = randomUUID();
        const verification: CodeVerificationInput = { executionId: parent.task.id, attemptId, candidate,
          baseBundle: { path: '/opt/factory/workload/verification/base.bundle', sha256: baseBundle.sha256 },
          candidateBundlePath: '/opt/factory/workload/verification/candidate.bundle', directory: '/opt/factory/verified', checks, identity: { uid: 1, gid: 1 } };
        snapshot = { attemptId, configuration: configuration(parent), input: canonicalJson({ role: { setup: selectedSetup(parent) }, verification, baseBundle, candidateFile }) };
        parent.checkpoint('verification:snapshot', snapshot);
      }
      const outcome = await finish(parent, snapshot, recovering);
      return { accepted: outcome.outcome === 'succeeded', evidence: { attemptId: snapshot.attemptId, ...outcome } };
    },
    async recoverVerification(parent: ExecutionContext) {
      const snapshot = parent.record('verification:snapshot') as Snapshot | null;
      if (snapshot) await finish(parent, snapshot, true);
    },
  };
}
