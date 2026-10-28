import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileConfiguration as compileRuntime, saveConfigurationArtifact, loadConfigurationArtifact } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileConfiguration } from '../src/configuration.js';
import { fixture } from './pipeline-fixture.js';

test('approval rules change application identity without entering runtime configuration or deployment artifacts', t => {
  const input = fixture();
  const compiled = compileConfiguration(input);
  const approved = compileConfiguration({ ...input, launchPolicy: { mode: 'maintainer-approval', minimumPermission: 'write', label: 'agent:run' } });
  assert.notEqual(compiled.setupDigest, approved.setupDigest);
  assert.notEqual(compiled.artifactDigest, approved.artifactDigest);
  assert.equal(compiled.runtime.artifactDigest, approved.runtime.artifactDigest);
  assert.ok(!('launchPolicy' in compiled.runtime.configuration));
  assert.throws(() => compileRuntime(input), /SCHEMA/);
  assert.throws(() => compileConfiguration({ ...input, launchPolicy: { mode: 'maintainer-approval', minimumPermission: 'write' } }), /SCHEMA/);
  assert.throws(() => compileConfiguration({ ...input, launchPolicy: { ...input.launchPolicy, ignored: true } }), /SCHEMA/);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'factory-infrastructure-')));
  t.after(() => rmSync(parent, { recursive: true }));
  const path = saveConfigurationArtifact(parent, compiled.runtime.configuration);
  const loaded = loadConfigurationArtifact(path, compiled.runtime.artifactDigest, 1048576);
  assert.deepEqual(loaded, compiled.runtime);
});
