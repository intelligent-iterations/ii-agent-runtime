import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGitHubFactory, type GitHubFactoryOptions } from '../src/github-factory.js';
import { createUsageLedger } from '../src/usage-ledger.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-preset-')));
  const setup = { schemaVersion: 1 as const, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart' as const, image: `example/image@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github' as const, repository: 'org/repo', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } };
  const requests: string[] = [];
  const options: GitHubFactoryOptions = {
    project: 'example', directory: root, repository: 'org/repo',
    roles: { code: { kind: 'code', authMode: 'api-key', credentialKey: 'CODEX_KEY', instructions: 'Implement', setup } }, workflows: {},
    binaries: { node: process.execPath, tart: '/unused', tofu: '/unused' }, coordination: { maxAgents: 2 },
    subject: 'operator', authorize: async () => ({ status: 'denied', evidenceId: 'explicit-denial' }),
    authenticatedFetch: async (url, init) => {
      requests.push(String(url)); assert.equal(init?.redirect, 'manual');
      return new Response(JSON.stringify({ name: 'CODEX_KEY', updated_at: '2026-09-25T00:00:00Z' }), { status: 200 });
    },
    billing: { mode: 'unknown', provider: 'openai' },
    acceptance: infrastructure => {
      assert.equal(infrastructure.repository, 'org/repo');
      assert.equal(infrastructure.verificationRoot, join(root, 'verification'));
      return { verify: async () => ({ accepted: false, evidence: { policy: 'explicit-rejection' } }) };
    },
  };
  return { root, setup, options, requests, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('preset wires runtime metadata checks and preserves explicit authorization, acceptance, and detached configuration', async () => {
  const f = fixture(); const configured = configureGitHubFactory(f.options);
  try {
    assert.equal(f.requests.length, 0);
    assert.equal((await configured.options.checks.authorize('operator', f.setup)).status, 'denied');
    assert.equal((await configured.options.checks.inspectSecret(f.setup.secrets[0]!)).status, 'verified');
    assert.deepEqual(f.requests, ['https://api.github.com/repos/org/repo/actions/secrets/CODEX_KEY']);
    f.options.roles.code!.instructions = 'mutated'; configured.client.roles.code!.instructions = 'also mutated';
    assert.equal(configured.options.factory.roles.code!.instructions, 'Implement');
    assert.equal(configured.options.factory.database, join(f.root, 'work.sqlite'));
  } finally { configured.dispose(); configured.dispose(); f.close(); }
});

test('preset usage delivery commits missing-evidence accounting to the on-prem ledger and survives reopen', async () => {
  const f = fixture(); const configured = configureGitHubFactory(f.options); const records = new Map<string, unknown>();
  try {
    const context = { attemptId: 'attempt', task: { id: 'task', input: JSON.stringify({ role: f.options.roles.code }) },
      record: (key: string) => records.get(key) ?? null, checkpoint: (key: string, value: unknown) => { records.set(key, value); } } as ExecutionContext;
    await configured.options.reportUsage(context, { interrupted: true, conclusion: 'cancelled', files: [], missingMetadata: ['result.json'], outputGaps: ['report.json'], sealedManifest: false });
    configured.dispose();
    const ledger = createUsageLedger({ directory: join(f.root, 'accounting'), destinationId: 'factory-on-prem' });
    try { const reports = ledger.list(); assert.equal(reports.length, 1); assert.equal(reports[0]!.evidence, 'missing'); assert.equal(reports[0]!.attemptId, 'attempt'); } finally { ledger.close(); }
  } finally { configured.dispose(); f.close(); }
});
