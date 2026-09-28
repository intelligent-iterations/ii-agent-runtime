import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';
import { createFactory } from '../src/index.js';
import { startLocalCoordinator } from '../src/local-coordinator.js';
import { launchFactory, type LaunchDependencies } from '../src/launch.js';
import { prepareLaunchManifest } from '../src/launch-preparation.js';
import { loadAgentManifest } from '../src/agent-manifest.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-launch-')));
  const source = join(root, 'source'); mkdirSync(source);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); writeFileSync(join(source, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } })); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  const commit = git('rev-parse', 'HEAD');
  const setup = parseSetup({ schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider: 'tart', options: factoryTartOptions(), image: 'registry.example/worker@sha256:' + 'a'.repeat(64), cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: 'org/factory', key: 'MODEL_KEY' }], capture: { paths: ['candidate.bundle'] } });
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ project: 'launch', repository: 'org/factory', directory: './state',
    agentsSource: './agents.yaml', agentsManifest: './state/resolved.yaml', roles: { code: { credentialKey: 'MODEL_KEY', setup } } }));
  writeFileSync(join(root, 'agents.yaml'), 'schemaVersion: 1\nagents:\n  - {name: one, repository: org/app, prompt: Fix one}\n  - {name: two, repository: org/app, prompt: Fix two}\n');
  let preparations = 0; let failStartup = false;
  const executed: string[] = [];
  const dependencies: LaunchDependencies = {
    async prepare(yaml, options) {
      preparations++;
      return prepareLaunchManifest(yaml, { ...options, acquire: {
        async resolve() { return commit; }, async checkout(_repo, sha, destination) {
          git('clone', '--', source, destination); execFileSync('/usr/bin/git', ['checkout', '--detach', sha], { cwd: destination, stdio: 'pipe' });
        },
      } });
    },
    async load() {
      const roles = loadAgentManifest(join(root, 'state/resolved.yaml'), { workflowRepository: 'org/factory', baseSetup: setup }).roles;
      const factory = { project: 'launch', database: join(root, 'state/work.sqlite'), roles };
      return { client: factory, default: { factory } as any, async preflight() {}, dispose() {} };
    },
    async start(options) {
      if (failStartup) throw Error('Interrupted before execution');
      const factory = createFactory(options.factory);
      const coordinator = await startLocalCoordinator({ database: options.factory.database, project: 'launch', pollMs: 10,
        async execute(context) { executed.push(context.task.id); return { outcome: 'succeeded', result: { commit: JSON.parse(context.task.input).baseCommit } }; } });
      return { ...factory, coordinatorFailed: coordinator.failure, async close() { await coordinator.close(); factory.close(); } };
    },
  };
  return { root, dependencies, executed, commit, preparations: () => preparations,
    fail(value: boolean) { failStartup = value; }, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('one launch prepares and submits multiple agents; a later batch gets distinct execution identities', async () => {
  const f = fixture();
  try {
    const first = await launchFactory(f.root, { dependencies: f.dependencies });
    assert.equal(first.accepted, true); assert.equal(first.agents.length, 2); assert.equal(f.executed.length, 2);
    assert.equal(first.state, 'completed');
    const second = await launchFactory(f.root, { dependencies: f.dependencies });
    assert.equal(second.accepted, true); assert.equal(f.executed.length, 4);
    assert.notEqual(first.agents[0]!.id, second.agents[0]!.id);
  } finally { f.close(); }
});

test('an interrupted batch resumes its original manifest despite edits to user YAML', async () => {
  const f = fixture();
  try {
    f.fail(true); await assert.rejects(launchFactory(f.root, { dependencies: f.dependencies }), /Interrupted/);
    writeFileSync(join(f.root, 'agents.yaml'), 'broken new configuration');
    f.fail(false);
    const result = await launchFactory(f.root, { dependencies: f.dependencies });
    assert.equal(result.accepted, true); assert.equal(result.agents.length, 2); assert.equal(f.preparations(), 1);
  } finally { f.close(); }
});

test('changed prepared configuration cannot resume an interrupted batch', async () => {
  const f = fixture();
  try {
    f.fail(true); await assert.rejects(launchFactory(f.root, { dependencies: f.dependencies }));
    const path = join(f.root, 'state/resolved.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Fix one', 'Different task'));
    f.fail(false); await assert.rejects(launchFactory(f.root, { dependencies: f.dependencies }), /configuration changed/);
    assert.equal(f.executed.length, 0);
  } finally { f.close(); }
});
