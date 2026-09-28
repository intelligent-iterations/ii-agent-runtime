import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWorkerWorkflow } from '../src/workflow.js';
import { parseAgentManifest } from '../src/agent-manifest.js';
import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';

test('coding agents can pin an inexpensive Codex model per manifest entry', () => {
  const setup = parseSetup({ schemaVersion: 1, id: 'base', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: `example/worker@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/factory', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } });
  const manifest = parseAgentManifest(`schemaVersion: 1\ndefaults: {codexSecret: CODEX_KEY}\nagents:\n  - name: cheap-test\n    model: gpt-6-luna\n    prompt: Fix the bug\n    repository: org/source\n    baseCommit: ${'b'.repeat(40)}\n`,
    { directory: '/factory', workflowRepository: 'org/factory', baseSetup: setup });
  assert.equal(manifest.roles['cheap-test']?.model, 'gpt-6-luna');
  const workflow = renderWorkerWorkflow('org/factory', setup);
  assert.match(workflow, /FACTORY_SECRET_0: "\$\{\{ secrets\.CODEX_KEY \}\}"/);
});
