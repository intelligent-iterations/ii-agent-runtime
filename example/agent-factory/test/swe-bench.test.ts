import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { prepareSweBenchCandidate, sweBenchAgentRequest } from '../src/swe-bench.js';
import type { RetainedAttempt } from '../src/guest-retain.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-swe-'))); const source = join(root, 'source'); mkdirSync(source);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init'); writeFileSync(join(source, 'text.txt'), 'before\n'); writeFileSync(join(source, 'delete.txt'), 'delete\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'base'); const base = git(source, 'rev-parse', 'HEAD');
  const bundle = join(root, 'base.bundle'); git(source, 'bundle', 'create', bundle, 'HEAD');
  writeFileSync(join(source, 'text.txt'), 'after\n'); chmodSync(join(source, 'text.txt'), 0o755);
  writeFileSync(join(source, 'binary.dat'), Buffer.from([0, 255, 34, 0, 90])); rmSync(join(source, 'delete.txt'));
  const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit: base, secretValues: [] });
  const instance = { instance_id: 'example__repo-1', repo: 'example/repo', base_commit: base, problem_statement: 'Fix the task' };
  const setup = { schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' }, deployment: { provider: 'tart', options: factoryTartOptions(), image: 'example/image@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['candidate.bundle'] } };
  const input = { repository: instance.repo, baseCommit: base, task: instance.problem_statement, role: { kind: 'code', setup } };
  const context = { task: { id: 'execution', input: JSON.stringify(input) }, attemptId: 'attempt' } as ExecutionContext;
  const retained = { worker: { executionId: 'execution', attemptId: 'attempt', candidate }, files: [{ path: candidate.bundle, localPath: join(source, candidate.bundle), size: candidate.size, sha256: candidate.sha256 }] } as RetainedAttempt;
  const options = { context, retained, instance, dataset: 'SWE-bench/SWE-bench_Verified', split: 'test', datasetRevision: 'b'.repeat(40), evaluatorRevision: '02e7a74ffd0b707aab73d203fe87bdc7c76afc8e', model: 'test-model', baseBundle: { path: bundle, sha256: hash(readFileSync(bundle)) }, directory: join(root, 'export') };
  return { root, source, git, base, candidate, options, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('exported native patch reproduces the exact candidate tree including binary bytes, mode changes and deletions', async () => {
  const f = await fixture();
  try {
    const result = await prepareSweBenchCandidate(f.options);
    const prediction = JSON.parse(readFileSync(result.predictionsPath, 'utf8'));
    assert.equal(prediction.instance_id, f.options.instance.instance_id); assert.equal(prediction.model_name_or_path, 'test-model');
    const independent = join(f.root, 'independent'); mkdirSync(independent); f.git(independent, 'init');
    f.git(independent, 'fetch', f.options.baseBundle.path, f.base); f.git(independent, 'checkout', '--detach', 'FETCH_HEAD');
    const patchPath = join(f.root, 'prediction.patch'); writeFileSync(patchPath, prediction.model_patch);
    f.git(independent, 'apply', '--index', patchPath);
    assert.equal(f.git(independent, 'write-tree'), f.candidate.tree);
    assert.deepEqual(readFileSync(join(independent, 'binary.dat')), Buffer.from([0, 255, 34, 0, 90]));
    assert.equal(hash(readFileSync(result.predictionsPath)), result.evaluation.predictionsSha256);
  } finally { f.close(); }
});

test('gold labels never enter submission and mismatched task or changed bundle cannot export', async () => {
  const f = await fixture();
  try {
    const datum = { ...f.options.instance, patch: 'gold secret answer', test_patch: 'hidden test', FAIL_TO_PASS: ['private'] };
    assert.deepEqual(sweBenchAgentRequest(datum, 'code'), { role: 'code', repository: datum.repo, baseCommit: datum.base_commit, task: datum.problem_statement });
    await assert.rejects(prepareSweBenchCandidate({ ...f.options, instance: { ...datum, problem_statement: 'different task' } }), /correlation/);
    writeFileSync(f.options.retained.files[0]!.localPath, 'changed bundle');
    await assert.rejects(prepareSweBenchCandidate(f.options), /artifact changed/);
  } finally { f.close(); }
});
