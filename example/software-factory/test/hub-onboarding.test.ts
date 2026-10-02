import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers';
import { createGitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { connectHub, type HubOnboardingDependencies } from '../src/hub-onboarding.js';
import { hubRecords } from '../src/hub-connection.js';
import { createProgress } from '../src/progress.js';

const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const hubRecord = { repository: 'example/software-factory', id: 5, branch: 'main' };
const legacyHubRecord = { repository: 'example/agent-factory', id: 5, branch: 'main' };

/**
 * A synthetic GitHub. `hubExists: 'legacy'` is a hub onboarded under the earlier name: `example/agent-factory`, with
 * `.agent-factory/hub.json` and its one workflow `.github/workflows/agent-factory.yml`.
 */
async function fake(t: { after(fn: () => void): void }, options: { hubExists?: 'hub' | 'foreign' | 'recorded' | 'legacy'; legacy?: boolean; installed?: boolean;
  appGone?: boolean; basePermission?: string; hubWriter?: boolean; strayWorkflow?: boolean } = {}) {
  await sodium.ready;
  const encryption = sodium.crypto_box_keypair();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-hub-onboarding-')));
  const marker = randomUUID();
  writeFileSync(join(root, '.test-owner'), marker, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(root, '.test-owner'), 'utf8'), marker); rmSync(root, { recursive: true }); });
  const legacy = options.legacy === true || options.hubExists === 'legacy';
  const name = legacy ? 'agent-factory' : 'software-factory';
  const repo = `/repos/example/${name}`;
  const state = { hubCreated: options.hubExists !== undefined, hubIssues: false, installed: options.installed === true, appGone: options.appGone === true,
    secrets: [] as string[], opened: [] as string[], output: '', pauses: 0, conversions: 0, deleted: [] as string[], markers: [] as string[] };
  const hub = () => ({ full_name: `example/${name}`, id: 5, private: true, archived: false, default_branch: 'main', permissions: { admin: true }, has_issues: state.hubIssues });
  const manifest = (kind?: string) => Response.json({ content: Buffer.from(JSON.stringify({ ...(kind ? { kind } : {}), organization: 'example', app: { id: 10 } })).toString('base64') });
  const api = createGitHubApi({ credential: () => 'synthetic-user-token', maxRequests: 500, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    if (path === '/user/memberships/orgs/example') return Response.json({ state: 'active', role: 'admin' });
    if (path === '/orgs/example/installations') return Response.json({ installations: state.installed
      ? [{ id: 200, app_id: 10, app_slug: 'software-factory-example', suspended_at: null, account: { login: 'example' }, repository_selection: 'all', permissions: { contents: 'write', issues: 'write', metadata: 'read' } }] : [] });
    if (path === '/orgs/example') return Response.json({ id: 1, plan: { name: 'free' }, default_repository_permission: options.basePermission ?? 'read' });
    if (path === repo && method === 'GET') return state.hubCreated ? Response.json(hub()) : new Response(null, { status: 404 });
    if (path === '/orgs/example/repos' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual([body.name, body.private, body.has_issues], [name, true, true]);
      assert.match(body.description, /^Software Factory: file an Agent task issue here/);
      state.hubCreated = true; state.hubIssues = true; return Response.json(hub(), { status: 201 });
    }
    if (path === `${repo}/git/ref/heads/main`) return Response.json({ object: { sha: 'a'.repeat(40) } });
    const marked = /^\/repos\/example\/[a-z-]+\/contents\/(\.[a-z-]+)\/hub\.json$/.exec(path);
    if (marked) {
      state.markers.push(marked[1]!);
      if (options.hubExists === 'recorded' && marked[1] === '.software-factory') return manifest();
      if (options.hubExists === 'legacy' && marked[1] === '.agent-factory') return manifest('agent-factory-hub');
      return new Response(null, { status: 404 });
    }
    if (path === `${repo}/git/trees/main`) return Response.json({ tree: [{ path: 'README.md' }, ...(options.hubExists === 'foreign' ? [{ path: 'src' }] : [])] });
    if (path === `${repo}/collaborators`) return Response.json([{ login: 'owner', permissions: { admin: true, push: true } },
      ...(options.hubWriter ? [{ login: 'contractor', permissions: { admin: false, push: true } }] : [])]);
    if (path === `${repo}/teams`) return Response.json([{ slug: 'readers', permission: 'pull' }]);
    if (path === `${repo}/contents/.github/workflows`) return state.hubCreated && options.hubExists !== undefined
      ? Response.json([{ name: `${name}.yml` }, ...(options.strayWorkflow ? [{ name: 'ci.yml' }] : [])]) : new Response(null, { status: 404 });
    if (path === '/app-manifests/main-code/conversions') {
      state.conversions++;
      return Response.json({ id: 10, slug: 'software-factory-example', pem: pem(), owner: { type: 'Organization', login: 'example' } }, { status: 201 });
    }
    if (path.endsWith('/actions/secrets/public-key')) return Response.json({ key_id: 'key', key: sodium.to_base64(encryption.publicKey, sodium.base64_variants.ORIGINAL) });
    const secret = new RegExp(`^${repo}/actions/secrets/([A-Z_]+)$`).exec(path);
    if (secret && method === 'PUT') { state.secrets.push(secret[1]!); return new Response(null, { status: 201 }); }
    if (secret) return Response.json({ name: secret[1] });
    const legacySecret = /^\/repos\/example\/(one|two)\/actions\/secrets\/([A-Z_0-9]+)$/.exec(path);
    if (legacySecret && method === 'DELETE') { state.deleted.push(`${legacySecret[1]}:${legacySecret[2]}`); return new Response(null, { status: 204 }); }
    if (legacySecret) return legacySecret[1] === 'two' ? Response.json({ name: 'OPENAI_API_KEY' }) : new Response(null, { status: 404 });
    const app = /^\/apps\/([a-z-]+)$/.exec(path);
    if (app) return state.appGone ? new Response(null, { status: 404 }) : Response.json({ id: 10 });
    throw Error(`Unexpected ${method} ${path}`);
  } });
  const records = hubRecords(root);
  const installed = Promise.withResolvers<number>();
  const dependencies: HubOnboardingDependencies = {
    api, records, progress: createProgress({ write: (text: string) => { state.output += text; }, isTTY: false }),
    browser: async () => ({ startUrl: 'http://127.0.0.1/start', manifest: {}, code: Promise.resolve('main-code'),
      installation: installed.promise, close: async () => {} }),
    // The user installs only after the install page opens; GitHub then calls back.
    open: async url => { state.opened.push(url); if (url.endsWith('/installations/new')) { state.installed = true; installed.resolve(200); } },
    pause: async () => { state.pauses++; state.installed = true; state.appGone = true; },
    confirm: async () => true,
  };
  return { dependencies, state, records, root };
}

test('a fresh run creates a private hub in the current layout, stores the App key only there, and finishes when the App is installed', async t => {
  const { dependencies, state, records } = await fake(t);
  const connection = await connectHub({ organization: 'Example', hubName: 'software-factory' }, dependencies);
  assert.deepEqual([connection.phase, connection.layout, connection.hub, connection.app], ['connected', 'current', hubRecord, { id: 10, slug: 'software-factory-example', installationId: 200 }]);
  assert.deepEqual(state.secrets, ['SOFTWARE_FACTORY_GITHUB_PRIVATE_KEY']);
  assert.ok(state.opened.includes('https://github.com/apps/software-factory-example/installations/new'), JSON.stringify(state.opened));
  assert.equal(records.load()?.layout, 'current');
  assert.match(state.output, /Opening GitHub to create the Software Factory App/);
  assert.match(state.output, /Created the App software-factory-example; its key is stored only in example\/software-factory/);
  assert.match(state.output, /installed on all repositories/);
});

test('an existing hub made under the earlier name is adopted in its own layout: its folder, workflow and secret names stay', async t => {
  const { dependencies, state, records } = await fake(t, { hubExists: 'legacy' });
  const connection = await connectHub({ organization: 'example', hubName: 'agent-factory' }, dependencies);
  assert.deepEqual([connection.phase, connection.layout, connection.hub], ['connected', 'legacy', legacyHubRecord]);
  assert.deepEqual(state.markers, ['.software-factory', '.agent-factory'], 'the hub is recognised by .agent-factory/hub.json');
  assert.deepEqual(state.secrets, ['AGENT_FACTORY_GITHUB_PRIVATE_KEY'], 'the hub workflow reads the App key from its own secret name');
  assert.equal(records.load()?.layout, 'legacy');
});

test('a connection recorded before layouts existed is a legacy hub, and resumes with its own secret names', async t => {
  const lost = await fake(t, { hubExists: 'hub', legacy: true });
  // Written by the earlier build: no layout field.
  writeFileSync(join(lost.root, 'hub-connection.json'), JSON.stringify({ schemaVersion: 2, organization: 'example', phase: 'app-created', hub: legacyHubRecord,
    app: { id: 10, slug: 'agent-factory-example' } }), { mode: 0o600 });
  assert.equal(lost.records.load()?.layout, 'legacy');
  const connection = await connectHub({ organization: 'example', hubName: 'software-factory' }, lost.dependencies);
  assert.deepEqual([connection.layout, connection.hub], ['legacy', legacyHubRecord], 'the recorded hub is used, not the default name');
  assert.deepEqual(lost.state.secrets, ['AGENT_FACTORY_GITHUB_PRIVATE_KEY']);
  assert.deepEqual(lost.state.markers, [], 'a recorded hub is not looked up again');
});

test('a run from the build with the repository question resumes without a new App and removes its local key files', async t => {
  const { dependencies, state, records, root } = await fake(t, { hubExists: 'hub', installed: true });
  writeFileSync(join(root, 'hub-connection.json'), JSON.stringify({ schemaVersion: 2, organization: 'example', phase: 'app-stored', layout: 'current', hub: hubRecord,
    app: { id: 10, slug: 'software-factory-example' }, repositories: [] }), { mode: 0o600 });
  writeFileSync(join(root, 'app-key.pem'), pem(), { mode: 0o600 });
  const connection = await connectHub({ organization: 'example', hubName: 'software-factory' }, dependencies);
  assert.equal(connection.phase, 'connected');
  assert.equal(state.conversions, 0, 'the existing App, whose key is already in the hub, is reused');
  assert.ok(!existsSync(join(root, 'app-key.pem')));
  assert.match(state.output, /Removed app-key.pem/);
  const earlier = await fake(t, { hubExists: 'hub', installed: true });
  earlier.records.save({ schemaVersion: 2, organization: 'example', phase: 'trigger-installed', layout: 'current', hub: hubRecord,
    app: { id: 10, slug: 'software-factory-example', installationId: 200 }, trigger: { id: 30, slug: 'trigger-example', installationId: 400 }, repositories: [] } as any);
  assert.equal(earlier.records.load()?.phase, 'app-stored');
  await connectHub({ organization: 'example', hubName: 'software-factory' }, earlier.dependencies);
  assert.match(earlier.state.output, /trigger-example, a trigger App from an earlier build, is no longer used/);
  assert.equal(records.load()?.phase, 'connected');
});

test('an App whose key never reached the hub is deleted first; a resumed install is confirmed and looked up', async t => {
  const lost = await fake(t, { hubExists: 'hub' });
  lost.records.save({ schemaVersion: 2, organization: 'example', phase: 'app-created', layout: 'current', hub: hubRecord, app: { id: 10, slug: 'software-factory-example' } });
  await connectHub({ organization: 'example', hubName: 'software-factory' }, lost.dependencies);
  assert.ok(lost.state.opened.includes('https://github.com/organizations/example/settings/apps/software-factory-example/advanced'));
  assert.match(lost.state.output, /software-factory-example deleted/);
  assert.equal(lost.state.conversions, 1);
  const resumed = await fake(t, { hubExists: 'hub' });
  resumed.records.save({ schemaVersion: 2, organization: 'example', phase: 'app-stored', layout: 'current', hub: hubRecord, app: { id: 10, slug: 'software-factory-example' } });
  assert.equal((await connectHub({ organization: 'example', hubName: 'software-factory' }, resumed.dependencies)).phase, 'connected');
  assert.equal(resumed.state.pauses, 1, 'without the creating run, the user confirms the installation');
});

test('a per-repository connection is replaced: its App is deleted, its key secrets removed, and remaining model keys reported', async t => {
  const legacy = await fake(t, { appGone: true });
  let reset = false;
  legacy.dependencies.legacy = { load: () => ({ schemaVersion: 1, organization: 'example', repositories: [{ name: 'example/one', id: 1 }, { name: 'example/two', id: 2 }],
    secretScope: 'repository', phase: 'connected', appSlug: 'agent-factory-old', privateKeySecret: 'AGENT_FACTORY_GITHUB_PRIVATE_KEY_9' } as any), reset: () => { reset = true; } };
  legacy.state.appGone = true;
  await connectHub({ organization: 'example', hubName: 'software-factory' }, legacy.dependencies);
  assert.ok(reset);
  assert.deepEqual(legacy.state.deleted, ['one:AGENT_FACTORY_GITHUB_PRIVATE_KEY_9', 'two:AGENT_FACTORY_GITHUB_PRIVATE_KEY_9']);
  assert.match(legacy.state.output, /OPENAI_API_KEY is still stored in example\/two\. Software Factory now keeps it in the hub only/);
});

test('an unsafe or foreign hub is refused before any App or key exists', async t => {
  for (const [options, message] of [[{ basePermission: 'write' }, /base permission "write"/], [{ hubWriter: true }, /Remove write access for contractor/],
    [{ hubExists: 'hub' as const, strayWorkflow: true }, /workflows other than Software Factory's/], [{ hubExists: 'legacy' as const, strayWorkflow: true }, /workflows other than Software Factory's/],
    [{ hubExists: 'foreign' as const }, /is not a Software Factory hub/],
    [{ hubExists: 'recorded' as const, installed: true }, /set up from another machine.*software-factory-example/]] as const) {
    const { dependencies, state } = await fake(t, options);
    await assert.rejects(connectHub({ organization: 'example', hubName: 'hubExists' in options && options.hubExists === 'legacy' ? 'agent-factory' : 'software-factory' }, dependencies), message);
    assert.deepEqual([state.secrets, state.conversions], [[], 0]);
  }
});
