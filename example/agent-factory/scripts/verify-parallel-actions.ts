/** Two real VM/runner/Actions acceptance lanes with independently checked overlap. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const [repository, image, workflowId, ref, commit, directory, mode] = process.argv.slice(2);
if (!repository || !image || !workflowId || !ref || !commit || !directory || (mode !== undefined && mode !== '--inspect-existing')) throw Error('Usage: verify-parallel-actions.ts repository image workflow-id ref exact-commit new-directory');
const root = resolve(directory); if (mode === undefined) mkdirSync(root, { mode: 0o700 });
const lanes = ['first', 'second'].map(name => join(root, name));
if (mode === undefined) {
const outcomes = await Promise.allSettled(lanes.map(lane => new Promise<void>((resolveExit, reject) => {
  const log = openSync(lane + '.log', 'wx', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./verify-actions.ts', import.meta.url)), repository, image, workflowId, ref, commit, lane, '--parallel-proof'], { stdio: ['ignore', log, log] });
  closeSync(log);
  child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(Error(`Lane exited ${code ?? signal}; inspect ${lane}.log and cleanup records`)));
})));
for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
}
const results = lanes.map(lane => {
  const proof = JSON.parse(readFileSync(join(lane, 'proof.json'), 'utf8'));
  const cleanup = JSON.parse(readFileSync(join(lane, 'cleanup.json'), 'utf8')); assert.equal(cleanup.independentlyAbsent, true);
  assert.equal(proof.result.accepted, true);
  const db = new DatabaseSync(join(lane, 'work.sqlite'), { readOnly: true });
  let receipt: { runnerId: number }; let manifestPath: string;
  try {
    receipt = JSON.parse(String(db.prepare("SELECT value FROM attempt_records WHERE key='verification:runnerReceipt'").get()!.value));
    manifestPath = JSON.parse(String(db.prepare("SELECT value FROM attempt_records WHERE key='verification:manifestPath'").get()!.value));
    const intent = JSON.parse(String(db.prepare("SELECT value FROM attempt_records WHERE key='verification:dispatchIntent'").get()!.value));
    assert.equal(intent.repository, repository); assert.equal(intent.workflowId, Number(workflowId)); assert.equal(intent.ref, ref); assert.equal(intent.commit, commit);
  } finally { db.close(); }
  const inventory = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${proof.workflowRunId}/jobs?filter=all&per_page=100`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(inventory.total_count, 1); assert.equal(inventory.jobs.length, 1); const job = inventory.jobs[0];
  assert.equal(job.runner_id, receipt.runnerId); assert.equal(job.head_sha, commit); assert.equal(job.conclusion, 'success');
  assert.ok(Number.isFinite(Date.parse(job.started_at)) && Number.isFinite(Date.parse(job.completed_at)));
  const checks = job.steps.filter((step: { name: string }) => step.name === 'Run protected acceptance checks');
  assert.equal(checks.length, 1); const check = checks[0]; assert.equal(check.conclusion, 'success');
  assert.ok(Number.isFinite(Date.parse(check.started_at)) && Number.isFinite(Date.parse(check.completed_at)));
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).setup.deployment.image, image);
  return { lane, manifestPath, workflowRunId: proof.workflowRunId, jobId: job.id, runnerId: job.runner_id, startedAt: check.started_at, completedAt: check.completed_at, jobStartedAt: job.started_at, jobCompletedAt: job.completed_at, accepted: true, independentlyAbsent: true };
});
assert.notEqual(results[0]!.workflowRunId, results[1]!.workflowRunId);
assert.notEqual(results[0]!.runnerId, results[1]!.runnerId);
assert.notEqual(results[0]!.manifestPath, results[1]!.manifestPath);
const overlapMs = Math.min(...results.map(r => Date.parse(r.completedAt))) - Math.max(...results.map(r => Date.parse(r.startedAt)));
writeFileSync(join(root, 'observations.json'), JSON.stringify({ results, overlapMs }, null, 2), { mode: 0o600 });
assert.ok(overlapMs > 0, 'Acceptance steps did not overlap; parallel execution is not proven');
writeFileSync(join(root, 'proof.json'), JSON.stringify({ results, overlapMs, modelCalls: 0, jobSecrets: 0 }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ workflowRunIds: results.map(r => r.workflowRunId), overlapMs, independentlyAbsent: true }));
