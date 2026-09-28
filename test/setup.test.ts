import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, checkSetup, LaunchDenied, parseSetup, setupDigest, withLaunchChecks, type CheckContext, type Setup } from '../src/index.js';

const setup = (): Setup => ({
  schemaVersion: 1, id: 'example', revision: 'r1',
  harness: { name: 'example-harness', version: '1.0' },
  deployment: { provider: 'tart', image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
  secrets: [{ provider: 'github', repository: 'example/work', environment: 'test', key: 'WORK_TOKEN' }],
  capture: { paths: ['result.json', 'logs/output.txt'] },
});
const context = (): CheckContext => ({ subject: 'trusted-subject',
  authorize: async () => ({ status: 'verified', evidenceId: 'authorization-1' }),
  inspectSecret: async () => ({ status: 'verified', evidenceId: 'metadata-1' }),
});

test('organization secret scope changes identity and rejects mixed or unrelated ownership', () => {
  const repository = setup(); delete repository.secrets[0]!.environment;
  const organization = structuredClone(repository); organization.secrets[0]!.organization = 'example';
  assert.notEqual(setupDigest(repository), setupDigest(organization));
  assert.equal(parseSetup(organization).secrets[0]!.organization, 'example');
  organization.secrets[0]!.environment = 'test'; assert.throws(() => parseSetup(organization), /Invalid setup/);
  delete organization.secrets[0]!.environment;
  organization.secrets[0]!.organization = 'other'; assert.throws(() => parseSetup(organization), /must own/);
});

test('digest ignores key order, set ordering and revision identity, but covers every resolved setting', () => {
  const a = setup();
  const reversed = (x: unknown): unknown => Array.isArray(x) ? x.map(reversed) : x && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x).reverse().map(([k,v]) => [k, reversed(v)])) : x;
  assert.equal(setupDigest(a), setupDigest(reversed(a)));
  const same = setup(); same.revision = 'r2'; same.capture.paths.reverse();
  assert.equal(setupDigest(a), setupDigest(same));
  const mutations: Array<(s: Setup) => void> = [
    s => { s.id = 'other'; }, s => { s.harness.version = '2'; }, s => { s.harness.name = 'other'; },
    s => { s.deployment.cpu++; }, s => { s.deployment.memoryMiB++; }, s => { s.deployment.provider = 'other'; },
    s => { s.deployment.image = `registry.example/base@sha256:${'b'.repeat(64)}`; },
    s => { s.secrets[0]!.key = 'OTHER'; }, s => { s.secrets[0]!.repository = 'example/other'; },
    s => { s.secrets[0]!.environment = 'other'; }, s => { s.capture.paths.push('other.txt'); },
  ];
  for (const mutate of mutations) { const changed = setup(); mutate(changed); assert.notEqual(setupDigest(a), setupDigest(changed)); }
});

test('strict schema rejects secret material, unknown fields, duplicate references, unsafe paths and mutable images', () => {
  const malformed: unknown[] = [
    { ...setup(), token: 'synthetic-sensitive-value' },
    { ...setup(), secrets: [{ ...setup().secrets[0], value: 'synthetic-sensitive-value' }] },
    { ...setup(), secrets: [...setup().secrets, ...setup().secrets] },
    { ...setup(), deployment: { ...setup().deployment, image: 'latest' } },
    ...['/etc/passwd', '../private', 'a/../b', 'a\\b', './a', 'a//b'].map(path => ({ ...setup(), capture: { paths: [path] } })),
  ];
  for (const value of malformed) assert.throws(() => parseSetup(value), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('synthetic-sensitive-value')); return true;
  });
  for (const value of [undefined, NaN, Infinity, new Date(), [undefined], Array(2)]) assert.throws(() => canonicalJson(value));
});

test('unknown, denied, thrown or malformed provider evidence never dispatches', async () => {
  for (const status of ['unknown', 'denied'] as const) {
    let dispatched = false;
    await assert.rejects(withLaunchChecks(setup(), { ...context(), inspectSecret: async () => ({ status, evidenceId: 'check' }) }, async () => { dispatched = true; }), LaunchDenied);
    assert.equal(dispatched, false);
  }
  const result = await checkSetup(setup(), { ...context(), inspectSecret: async () => { throw new Error('synthetic-sensitive-value'); } });
  assert.equal(result.allowed, false);
  assert.equal(result.secrets[0]?.observation.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-value'));
  assert.equal((await checkSetup(setup(), { ...context(), inspectSecret: async () => ({ status: 'verified', evidenceId: '' }) })).allowed, false);
});

test('authorization denial prevents metadata reads, even with no secrets', async () => {
  let reads = 0;
  const ctx: CheckContext = { ...context(), authorize: async () => ({ status: 'denied', evidenceId: 'denial' }), inspectSecret: async () => { reads++; return { status: 'verified', evidenceId: 'metadata' }; } };
  assert.equal((await checkSetup(setup(), ctx)).allowed, false);
  assert.equal((await checkSetup({ ...setup(), secrets: [] }, ctx)).allowed, false);
  assert.equal(reads, 0);
  assert.equal((await checkSetup(setup(), { ...context(), subject: '' })).allowed, false);
});

test('every invocation obtains fresh evidence; a previous pass cannot bypass revocation', async () => {
  let permitted = true; let dispatched = 0; let checks = 0;
  const ctx: CheckContext = { ...context(), inspectSecret: async () => { checks++; return { status: permitted ? 'verified' : 'denied', evidenceId: `check-${checks}` }; } };
  await withLaunchChecks(setup(), ctx, async (_, evidence) => { dispatched++; assert.equal(evidence.allowed, true); });
  permitted = false;
  await assert.rejects(withLaunchChecks(setup(), ctx, async () => { dispatched++; }), LaunchDenied);
  assert.equal(checks, 2); assert.equal(dispatched, 1);
});

test('caller and adapter mutation cannot change the inputs deployed after checking', async () => {
  const input = setup(); const original = setupDigest(input);
  const ctx: CheckContext = { ...context(), authorize: async (_, supplied) => {
    input.deployment.cpu = 64; supplied.deployment.cpu = 128;
    return { status: 'verified', evidenceId: 'auth' };
  }, inspectSecret: async ref => { ref.key = 'UNRELATED'; return { status: 'verified', evidenceId: 'metadata' }; } };
  await withLaunchChecks(input, ctx, async (checked, evidence) => {
    assert.equal(checked.deployment.cpu, 2);
    assert.equal(evidence.digest, original);
    assert.equal(evidence.secrets[0]?.reference.key, 'WORK_TOKEN');
  });
});

test('each setup checks exactly its own declared secret assignments', async () => {
  const seen: string[] = [];
  const ctx: CheckContext = { ...context(), inspectSecret: async ref => { seen.push(ref.key); return { status: 'verified', evidenceId: ref.key }; } };
  const a = setup(); const b = setup(); b.id = 'second'; b.secrets[0]!.key = 'RESEARCH_TOKEN';
  await Promise.all([checkSetup(a, ctx), checkSetup(b, ctx)]);
  assert.deepEqual(seen.sort(), ['RESEARCH_TOKEN', 'WORK_TOKEN']);
});
