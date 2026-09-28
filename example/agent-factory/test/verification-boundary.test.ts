import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadVerificationConfig } from '../scripts/verification-config.js';

test('live verification requires deployment-owned coordinates', () => {
  assert.throws(() => loadVerificationConfig(''), /FACTORY_VERIFICATION_CONFIG/);
  const directory = mkdtempSync(join(tmpdir(), 'factory-verification-config-'));
  try {
    const path = join(directory, 'config.json');
    const valid = {
      repository: 'sample/factory', sourceRepository: 'sample/source',
      workerWorkflowId: 11, verificationWorkflowId: 12,
      workflowRef: 'approved-worker', verificationWorkflowRef: 'approved-verifier',
      verificationWorkflowCommit: 'a'.repeat(40),
    };
    writeFileSync(path, JSON.stringify(valid));
    assert.deepEqual(loadVerificationConfig(path), valid);
    writeFileSync(path, JSON.stringify({ ...valid, repository: 'invalid', workerWorkflowId: 0 }));
    assert.throws(() => loadVerificationConfig(path), /repository/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('live scripts contain no deployment repository or workflow coordinates', () => {
  for (const name of [
    'verify-actions.ts', 'verify-actions-crash.ts', 'verify-code-guest.ts',
    'verify-parallel-actions.ts', 'verify-swe-plugin.ts',
  ]) {
    const source = readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"`]intelligent-iterations\//);
    assert.doesNotMatch(source, /(?:workerWorkflowId|verificationWorkflowId)\s*:\s*\d/);
    assert.match(source, /process\.argv|loadVerificationConfig\(\)/);
  }
});
