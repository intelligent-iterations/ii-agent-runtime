#!/usr/bin/env node
// Read-only audit of a dedicated App-backed factory installation.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { inspectTartDeployment, inspectLibvirtDeployment } from '@intelligent-iterations/ii-agent-runtime';
import { appAuthenticatedFetch, openFactoryApp } from '../dist/factory-app-auth.js';

const [installationDirectory, expectedCount] = process.argv.slice(2);
const count = Number(expectedCount);
assert.ok(installationDirectory && Number.isSafeInteger(count) && count > 0,
  'Usage: node scripts/verify-onboarding.mjs INSTALLATION_DIRECTORY EXPECTED_ACCEPTED_COUNT');
const root = resolve(installationDirectory);
const installation = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
const appHandle = openFactoryApp(installation.appConfigPath, resolve(root, installation.directory));
const database = new DatabaseSync(resolve(root, installation.directory, 'work.sqlite'), { readOnly: true });
const request = async (repository, path) => {
  const response = await appAuthenticatedFetch(appHandle.app, repository)(`https://api.github.com/repos/${repository}/${path}`, { method: 'GET' });
  assert.equal(response.status, 200, `GitHub observation failed for ${repository}/${path}`);
  return response.json();
};
try {
  const tasks = database.prepare('select id,name,state,result,input from tasks').all();
  assert.equal(tasks.filter(task => ['running', 'queued'].includes(task.state)).length, 0, 'Work is still active');
  const accepted = tasks.filter(task => task.state === 'succeeded');
  assert.equal(accepted.length, count, 'Unexpected accepted-task count');
  const evidence = [];
  const ownedRunnerIds = new Set();
  for (const task of accepted) {
    const result = JSON.parse(task.result);
    assert.equal(result.verification.accepted, true);
    const worker = result.retained.worker;
    assert.equal(worker.state, 'completed');
    assert.equal(result.publication.commit, worker.candidate.commit);
    const remote = await request(result.publication.repository, `git/ref/${result.publication.ref.slice(5)}`);
    assert.equal(remote.object.sha, worker.candidate.commit, 'Published branch changed');
    const verified = result.verification.evidence.result.retained.result;
    assert.equal(verified.commit, worker.candidate.commit);
    assert.equal(verified.bundleSha256, worker.candidate.sha256);
    assert.ok(verified.checks.length > 0 && verified.checks.every(check => check.passed && check.exitCode === 0));
    const records = database.prepare('select key,value from attempt_records where attempt_id in (select id from attempts where task_id=?)').all(task.id);
    const runIds = records.filter(row => row.key.endsWith('workflowRunId')).map(row => Number(JSON.parse(row.value)));
    assert.equal(runIds.length, 2, 'Expected worker and verifier runs');
    const runs = [];
    for (const id of runIds) {
      const run = await request(installation.repository, `actions/runs/${id}`);
      assert.equal(run.conclusion, 'success');
      const jobs = (await request(installation.repository, `actions/runs/${id}/jobs`)).jobs;
      assert.equal(jobs.length, 1);
      assert.ok(jobs[0].labels.includes('self-hosted'));
      ownedRunnerIds.add(jobs[0].runner_id);
      runs.push({ id, url: run.html_url, runnerId: jobs[0].runner_id });
    }
    evidence.push({ task: task.name, publication: result.publication, runs, checks: verified.checks });
  }
  const deployments = [];
  for (const row of database.prepare("select value from attempt_records where key like '%manifestPath'").all()) {
    const path = JSON.parse(row.value);
    const provider = JSON.parse(readFileSync(path, 'utf8')).setup?.deployment?.provider;
    assert.ok(provider === 'tart' || provider === 'libvirt', 'Unexpected VM provider');
    const observed = provider === 'libvirt' ? await inspectLibvirtDeployment(path) : await inspectTartDeployment(path);
    assert.equal(observed.present, false, 'An owned VM is still present');
    deployments.push({ path, present: observed.present });
  }
  const runners = (await request(installation.repository, 'actions/runners?per_page=100')).runners;
  assert.ok(runners.every(runner => !ownedRunnerIds.has(runner.id)), 'An owned runner remains registered');
  const grants = appHandle.ledger.current();
  assert.ok(grants.some(grant => grant.provider === 'github-app'), 'Missing GitHub App access receipts');
  const proof = { verifiedAt: new Date().toISOString(), evidence, deployments,
    ownedRunnersRemaining: 0, grants: grants.map(grant => ({ id: grant.id, recipient: grant.recipient,
      resource: grant.resource, capabilities: grant.capabilities, authorizedBy: grant.authorizedBy,
      issuedBy: grant.issuedBy, grantedAt: grant.grantedAt, expiresAt: grant.expiresAt,
      endedAt: grant.endedAt, observation: grant.observation })) };
  writeFileSync(join(root, 'live-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ accepted: evidence.length, absentVMs: deployments.length, ownedRunnersRemaining: 0 }));
} finally { database.close(); appHandle.close(); }
