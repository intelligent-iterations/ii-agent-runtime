import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';
import { parseAgentManifest } from '../src/agent-manifest.js';
import { factoryTartOptions } from '../src/defaults.js';

const baseSetup = parseSetup({ schemaVersion: 1, id: 'template', revision: '1', harness: { name: 'codex', version: '0.156.1' },
  deployment: { provider: 'tart', options: factoryTartOptions(), image: 'registry.example/worker@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 },
  secrets: [{ provider: 'github', repository: 'org/factory', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } });
const parse = (input: unknown) => parseAgentManifest(stringify(input), { directory: '/factory', workflowRepository: 'org/factory', baseSetup });

test('agent manifest binds only the trusted Codex secret and explicit GitHub policy', () => {
  const manifest = parse({ schemaVersion: 1, defaults: { codexSecret: 'CODEX_KEY' }, agents: [
    { name: 'a', prompt: 'Fix A', repository: 'org/a', baseCommit: 'a'.repeat(40) },
    { name: 'b', prompt: 'Fix B', repository: 'org/b', baseCommit: 'b'.repeat(40), githubPermissions: { issues: 'write' } },
  ] });
  assert.deepEqual(manifest.roles.a?.setup.secrets.map(secret => secret.key), ['CODEX_KEY']);
  assert.deepEqual(manifest.roles.a?.githubPermissions, undefined);
  assert.deepEqual(manifest.roles.b?.githubPermissions, { issues: 'write' });
  assert.deepEqual(manifest.agents.map(agent => agent.request.repository), ['org/a', 'org/b']);
});

test('agent manifest rejects credential selection and malformed permission policy', () => {
  const agent = { name: 'a', prompt: 'Fix', repository: 'org/a', baseCommit: 'a'.repeat(40) };
  const input = { schemaVersion: 1, defaults: { codexSecret: 'CODEX_KEY' }, agents: [agent] };
  assert.throws(() => parse({ ...input, agents: [{ ...agent, secrets: { repository: 'TOKEN' } }] }), /unsupported field/);
  assert.throws(() => parse({ ...input, agents: [{ ...agent, githubPermissions: { contents: 'admin' } }] }), /Invalid agent GitHub permissions/);
  assert.throws(() => parse({ ...input, agents: [agent, { ...agent }] }), /Duplicate/);
  assert.throws(() => parse({ ...input, defaults: { codexSecret: 'sk-actual-secret' } }), /secret name/);
});
