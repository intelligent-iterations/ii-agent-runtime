/** Reopen an agent-produced benchmark in a fresh process; all provider calls are forbidden. */
import assert from 'node:assert/strict';
import { loadVerificationConfig } from './verification-config.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSweBenchBenchmark } from '../src/swe-bench-controller.js';
import { WorkStore } from '../src/store.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

const verificationConfig = loadVerificationConfig();
if (!process.argv[2]) throw Error('Usage: replay-swe-agent.ts proof-directory');
const root = resolve(process.argv[2]);
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
const proof = JSON.parse(readFileSync(join(root, 'proof.json'), 'utf8'));
const store = new WorkStore(join(root, 'work.sqlite'));
let requests = 0;
try {
  const task = store.get(proof.taskId); assert.equal(task.state, 'succeeded');
  const attemptId = proof.attemptId;
  const context: ExecutionContext = { task, attemptId, cancelled: () => false,
    record: key => store.record(attemptId, key), checkpoint: (key, value) => store.checkpoint(attemptId, key, value) };
  const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
  const benchmark = createSweBenchBenchmark({ root: join(root, 'benchmark'), outputRoot: join(root, 'benchmark-outputs'),
    setup: input.evaluatorSetup, policyRevision: 'real-agent-measurement-v1', model: input.model ?? 'codex-0.156.1-default-model-unreported', timeoutSeconds: 300,
    dataset: input.dataset, instance: async () => input.instance, baseBundle: async () => input.baseBundle,
    image: async () => ({ reference: 'swebench/sweb.eval.x86_64.psf_1776_requests-1142@sha256:fa9c859412109d003a68c2bbe3c65541ca4714526afeb6906fe589c18af0b30d', architecture: 'amd64', allowEmulation: true }),
    repository: verificationConfig.repository, workflow: { ...input.workflow, id: verificationConfig.verificationWorkflowId },
    binaries: { node: process.execPath, tart: binary('tart'), tofu: binary('tofu') },
    transport: { request: async () => { requests++; throw Error('Replay provider access forbidden'); } },
    checks: { subject: 'real-agent-benchmark', authorize: async () => { throw Error('Replay launch forbidden'); }, inspectSecret: async () => { throw Error('Replay secret access forbidden'); } } });
  const result = await benchmark.recover(context); assert.deepEqual(result, proof.result); assert.equal(requests, 0);
  writeFileSync(join(root, 'fresh-process-replay.json'), JSON.stringify({ taskId: task.id, attemptId, result, providerCalls: requests, modelCalls: 0 }, null, 2), { mode: 0o600 });
  console.log('Fresh-process benchmark replay matched the retained native result with zero provider calls.');
} finally { store.close(); }
