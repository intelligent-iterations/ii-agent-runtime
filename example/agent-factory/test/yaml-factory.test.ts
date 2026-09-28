import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFactory } from '../src/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';
import { parseAgentManifest } from '../src/agent-manifest.js';
import { startLocalCoordinator } from '../src/local-coordinator.js';
import { WorkStore } from '../src/store.js';

const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('128-agent YAML run did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('one YAML file submits 128 distinct coding agents and the local coordinator executes each once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-yaml-run-'));
  const database = join(root, 'work.sqlite');
  const setup = parseSetup({ schemaVersion: 1, id: 'base', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: 'test@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/factory', key: 'CODEX_KEY' }], capture: { paths: ['candidate.bundle'] } });
  const yaml = stringify({ schemaVersion: 1, maxConcurrentAgents: 64, defaults: { codexSecret: 'CODEX_KEY' },
    profiles: {
      web: { image: 'test/web@sha256:' + 'b'.repeat(64), cpu: 2, memoryMiB: 2048 },
      app: { image: 'test/app@sha256:' + 'c'.repeat(64), cpu: 4, memoryMiB: 4096 },
    },
    agents: Array.from({ length: 128 }, (_, i) => ({
    name: `agent-${i}`, prompt: `Do task ${i}`, repository: `org/repo-${i}`, baseCommit: i.toString(16).padStart(40, '0'),
    checkout: `./source-${i}`, profile: i % 2 ? 'app' : 'web', githubPermissions: { issues: 'read' },
  })) });
  const manifest = parseAgentManifest(yaml, { directory: root, workflowRepository: 'org/factory', baseSetup: setup });
  const client = join(root, 'client.json'); const agents = join(root, 'agents.yaml');
  writeFileSync(client, JSON.stringify({ project: 'yaml', database, roles: manifest.roles }));
  writeFileSync(agents, yaml);
  let coordinator: Awaited<ReturnType<typeof startLocalCoordinator>> | undefined;
  const store = new WorkStore(database);
  try {
    const submit = () => { const factory = createFactory({project:'yaml', database, roles:manifest.roles});
      try { return manifest.agents.map(agent => factory.spawn(agent.name, agent.request).inspect()); } finally { factory.close(); } };
    const submitted = submit();
    assert.equal(submitted.length, 128);
    const observed = new Map<string, { prompt: string; repository: string; codex: string; github: string; memoryMiB: number }>();
    coordinator = await startLocalCoordinator({ database, project: 'yaml', maxConcurrentAgents: 64, pollMs: 10,
      execute: async context => {
        const input = JSON.parse(context.task.input);
        observed.set(context.task.name, { prompt: input.task, repository: input.repository,
          codex: input.role.credentialKey, github: input.role.githubPermissions.issues, memoryMiB: input.role.setup.deployment.memoryMiB });
        return { outcome: 'succeeded', result: { accepted: context.task.name } };
      },
    });
    await wait(() => store.list('yaml').every(task => task.state === 'succeeded'));
    assert.equal(observed.size, 128);
    for (let i = 0; i < 128; i++) assert.deepEqual(observed.get(`agent-${i}`), {
      prompt: `Do task ${i}`, repository: `org/repo-${i}`, codex: 'CODEX_KEY', github: 'read',
      memoryMiB: i % 2 ? 4096 : 2048,
    });
    const repeated = submit();
    assert.deepEqual(repeated.map((agent: { id: string }) => agent.id), submitted.map((agent: { id: string }) => agent.id));
    assert.equal(store.list('yaml').length, 128);
  } finally { await coordinator?.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
