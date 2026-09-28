import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWorkerWorkflow, renderVerificationWorkflow } from '../src/workflow.js';

const setup = { schemaVersion: 1, id: 'worker', revision: '1', harness: { name: 'codex', version: '0.156.1' },
  deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
  capture: { paths: ['candidate.bundle'] }, secrets: [] as { provider: 'github'; repository: string; key: string; environment?: string; organization?: string }[] };
const secret = (key: string) => ({ provider: 'github' as const, repository: 'org/factory', key });

test('all coding agents share one workflow with a fixed Codex secret', () => {
  const first = renderWorkerWorkflow('org/factory', { ...setup, secrets: [secret('CODEX_A')] });
  const second = renderWorkerWorkflow('org/factory', { ...setup, id: 'other', secrets: [secret('CODEX_A')] });
  assert.equal(first, second);
  assert.match(first, /FACTORY_SECRET_0: "\$\{\{ secrets.CODEX_A \}\}"/);
  assert.doesNotMatch(first, /inputs.secret_/);
  assert.match(first, /permissions: \{\}/);
  assert.match(first, /runs-on: \[self-hosted,/);
  assert.ok(first.indexOf('a.workflowCommit!==process.env.GITHUB_SHA') < first.indexOf('FACTORY_SECRET_0'));
  assert.doesNotMatch(first, /upload-artifact|actions\/cache|ubuntu-latest|secrets: inherit|pull_request|REPO_A/);
});

test('unsupported secret scopes, duplicates and control variables fail before publishing', () => {
  for (const secrets of [
    [{ ...secret('TOKEN'), repository: 'other/repo' }],
    [{ ...secret('TOKEN'), environment: 'production' }],
    [{ ...secret('TOKEN'), organization: 'org' }],
    [secret('TOKEN'), secret('TOKEN')],
    [secret('TOKEN'), secret('REPO_TOKEN')],
    [secret('NODE_OPTIONS')], [secret('GITHUB_TOKEN')],
  ]) assert.throws(() => renderWorkerWorkflow('org/factory', { ...setup, secrets }));
});

test('verification remains a separate credential-free job', () => {
  const verification = { ...setup, harness: { name: 'verification', version: '1' } };
  const output = renderVerificationWorkflow('org/factory', verification);
  assert.match(output, /run: exec sudo -n \/bin\/sh \/opt\/factory\/workload\/verify.sh/);
  assert.match(output, /permissions: \{\}/);
  assert.doesNotMatch(output, /secrets\[|FACTORY_SECRET_|worker.mjs/);
  assert.throws(() => renderVerificationWorkflow('org/factory', { ...verification, secrets: [secret('TOKEN')] }), /credential-free/);
});
