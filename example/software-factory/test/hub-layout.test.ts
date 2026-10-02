import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { githubConsumerNames } from '@intelligent-iterations/ii-agent-runtime/github';
import { CURRENT_LAYOUT, hubLayout, LEGACY_LAYOUT } from '../src/identity.js';
import { validateHubManifest } from '../src/hub-files.js';
import { planHub } from '../src/hub-setup.js';
import { samplePolicy } from './policy-fixture.js';
import { connectionDirectory, openConnectionStore } from '../src/connection-store.js';
import { hubRecords } from '../src/hub-connection.js';

const connected = (layout: 'current' | 'legacy', repository: string) => ({ schemaVersion: 2 as const, organization: 'example', phase: 'connected' as const, layout,
  hub: { repository, id: 5, branch: 'main' }, app: { id: 10, slug: 'example-app', installationId: 20 } });

test('every new hub gets the Software Factory names', () => {
  assert.equal(hubLayout('current'), CURRENT_LAYOUT);
  assert.deepEqual(CURRENT_LAYOUT.identity, { name: 'software-factory', displayName: 'Software Factory' });
  assert.deepEqual([CURRENT_LAYOUT.workflowPath, CURRENT_LAYOUT.configurationDirectory, CURRENT_LAYOUT.manifestKind, CURRENT_LAYOUT.appKeySecret,
    CURRENT_LAYOUT.runtimeKeySecret, CURRENT_LAYOUT.defaultHubRepository], ['.github/workflows/software-factory.yml', '.software-factory', 'software-factory-hub',
    'SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY', 'SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY', 'software-factory']);
  const names = githubConsumerNames(CURRENT_LAYOUT.identity);
  assert.deepEqual([names.ledgerEnvironment, names.reserveTask, names.authorEmail], ['software-factory-reservations', 'software-factory:reserve', 'software-factory@users.noreply.github.com']);
});

test('a hub onboarded as Agent Factory keeps every durable name and only reads "Software Factory"', () => {
  assert.equal(hubLayout('legacy'), LEGACY_LAYOUT);
  assert.deepEqual(LEGACY_LAYOUT.identity, { name: 'agent-factory', displayName: 'Software Factory' });
  assert.deepEqual([LEGACY_LAYOUT.workflowPath, LEGACY_LAYOUT.configurationDirectory, LEGACY_LAYOUT.manifestPath, LEGACY_LAYOUT.policyPath, LEGACY_LAYOUT.manifestKind,
    LEGACY_LAYOUT.appKeySecret, LEGACY_LAYOUT.runtimeKeySecret], ['.github/workflows/agent-factory.yml', '.agent-factory', '.agent-factory/hub.json', '.agent-factory/policy.json',
    'agent-factory-hub', 'AGENT_FACTORY_GITHUB_PRIVATE_KEY', 'AGENT_FACTORY_RUNTIME_DEPLOY_KEY']);
  // Ledger records are found by these names; the display name is only written into a description.
  const names = githubConsumerNames(LEGACY_LAYOUT.identity);
  assert.deepEqual([names.ledgerEnvironment, names.reserveTask, names.decideTask, names.reservationKind, names.decisionKind, names.authorEmail],
    ['agent-factory-reservations', 'agent-factory:reserve', 'agent-factory:decide', 'agent-factory-reservation', 'agent-factory-decision', 'agent-factory@users.noreply.github.com']);
  assert.equal(names.ledgerDescription, 'Software Factory launch quota reservation');
});

test('an existing hub\'s plan rewrites its own workflow, folder and secrets, and never adds a second workflow', () => {
  const source = { repository: 'example/runtime', revision: 'c'.repeat(40), readSshKeySecret: 'AGENT_FACTORY_RUNTIME_DEPLOY_KEY' };
  const plan = planHub(connected('legacy', 'example/agent-factory'), samplePolicy(), source, { registryLogin: false });
  assert.equal(plan.layout, LEGACY_LAYOUT);
  assert.deepEqual(Object.keys(plan.files).sort(), ['.agent-factory/hub.json', '.agent-factory/policy.json', '.github/ISSUE_TEMPLATE/agent-task.yml',
    '.github/ISSUE_TEMPLATE/config.yml', '.github/workflows/agent-factory.yml']);
  assert.deepEqual(Object.keys(plan.files).filter(path => path.startsWith('.github/workflows/')), ['.github/workflows/agent-factory.yml']);
  assert.equal(JSON.parse(plan.files['.agent-factory/hub.json']!).kind, 'agent-factory-hub');
  const workflow = parse(plan.files['.github/workflows/agent-factory.yml']!);
  const steps = workflow.jobs.agent.steps;
  const launch = steps.find((step: any) => step.id === 'launch');
  assert.equal(workflow.name, 'Software Factory');
  assert.equal(launch.env.FACTORY_HUB_LAYOUT, 'legacy', 'the launch reads this hub in its own layout');
  assert.equal(launch.env.FACTORY_APP_PRIVATE_KEY, '${{ secrets.AGENT_FACTORY_GITHUB_PRIVATE_KEY }}', 'the App key secret it already holds');
  assert.equal(launch.env.FACTORY_CODEX_API_KEY, '${{ secrets.OPENAI_API_KEY }}');
  assert.equal(steps[0].with['ssh-key'], '${{ secrets.AGENT_FACTORY_RUNTIME_DEPLOY_KEY }}');
  assert.throws(() => planHub(connected('legacy', 'example/agent-factory'), samplePolicy(), { ...source, readSshKeySecret: 'SOFTWARE_FACTORY_RUNTIME_DEPLOY_KEY' },
    { registryLogin: false }), /Invalid hub workflow input/, 'a legacy hub never reads a deploy key it does not have');
});

test('a manifest is read only as the layout its workflow names', () => {
  const manifest = (kind: string) => ({ schemaVersion: 2, kind, organization: 'example', hub: { repository: 'example/agent-factory', id: 5, branch: 'main' }, app: { id: 10, installationId: 20 } });
  assert.equal(validateHubManifest(manifest('agent-factory-hub'), LEGACY_LAYOUT).kind, 'agent-factory-hub');
  assert.throws(() => validateHubManifest(manifest('agent-factory-hub'), CURRENT_LAYOUT), /Invalid hub manifest/);
  assert.throws(() => validateHubManifest(manifest('software-factory-hub'), LEGACY_LAYOUT), /Invalid hub manifest/);
});

test('onboarding records stay where an earlier build put them: an existing ~/.config/agent-factory/<org> is used in place, never moved', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'factory-connection-home-')));
  const marker = randomUUID();
  writeFileSync(join(home, '.test-owner'), marker, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(home, '.test-owner'), 'utf8'), marker); rmSync(home, { recursive: true }); });
  const current = join(home, '.config', 'software-factory', 'example');
  const earlier = join(home, '.config', 'agent-factory', 'example');
  assert.equal(connectionDirectory(home, 'example'), current, 'a machine with no records starts in the new place');
  mkdirSync(earlier, { recursive: true, mode: 0o700 });
  const record = JSON.stringify({ schemaVersion: 2, organization: 'example', phase: 'connected', hub: { repository: 'example/agent-factory', id: 5, branch: 'main' },
    app: { id: 10, slug: 'agent-factory-example', installationId: 20 } });
  writeFileSync(join(earlier, 'hub-connection.json'), record, { mode: 0o600 });
  writeFileSync(join(earlier, 'runtime.json'), '{}', { mode: 0o600 });
  const before = statSync(join(earlier, 'hub-connection.json'));
  assert.equal(connectionDirectory(home, 'example'), earlier);
  const store = openConnectionStore(connectionDirectory(home, 'example'));
  assert.equal(store.directory, earlier);
  assert.deepEqual([hubRecords(store.directory).load()?.layout, hubRecords(store.directory).load()?.hub?.repository], ['legacy', 'example/agent-factory']);
  store.close();
  const after = statSync(join(earlier, 'hub-connection.json'));
  assert.deepEqual([readFileSync(join(earlier, 'hub-connection.json'), 'utf8'), after.ino, after.mtimeMs], [record, before.ino, before.mtimeMs], 'the record is not rewritten');
  assert.deepEqual(readdirSync(earlier).sort(), ['hub-connection.json', 'runtime.json']);
  assert.ok(!existsSync(join(home, '.config', 'software-factory')), 'nothing is created in the new place');
  // Once the new place exists it wins; the earlier folder is left alone.
  mkdirSync(current, { recursive: true, mode: 0o700 });
  assert.equal(connectionDirectory(home, 'example'), current);
  assert.ok(existsSync(join(earlier, 'hub-connection.json')));
  assert.throws(() => connectionDirectory(home, '../example'), /Invalid organization/);
});
