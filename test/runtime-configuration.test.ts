import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { canonicalJson, compileConfiguration, compileConfigurationText, defineRuntime, ConfigurationError } from '../src/runtime/configuration.js';
import { fixture } from './runtime-fixture.js';

test('RFC 8785 number, Unicode, escaping and UTF-16 key-order conformance vector', () => {
  const input = { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'one', '\ud83d\ude00': 'emoji', '\u0080': 'control', '\u00f6': 'o' };
  assert.equal(canonicalJson(input), '{"\\r":"CR","1":"one","\u0080":"control","ö":"o","€":"Euro","😀":"emoji","דּ":"Hebrew"}');
  assert.equal(canonicalJson([333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0]), '[333333333.3333333,1e+30,4.5,0.002,1e-27,0]');
});

test('generated authoring variants agree; semantic changes affect identity, revisions only affect artifact identity', () => {
  let seed = 0x51;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 100; i++) {
    const input = fixture();
    input.id = `generated-${i}`;
    input.instructions = `Fix issue ${Math.floor(random() * 100000)}. Preserve Unicode: é 😀`;
    input.source.additionalRepositories = [
      { repository: 'example/z', permissions: { contents: 'read' } },
      { repository: 'example/a', permissions: { contents: 'write', issues: 'read' } },
    ];
    const expected = compileConfiguration(input);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    assert.deepEqual(compileConfigurationText(JSON.stringify(reversed), 'json'), expected, `seed 0x51 case ${i}`);
    assert.deepEqual(compileConfigurationText(stringify(reversed), 'yaml'), expected);
    assert.deepEqual(compileConfiguration(defineRuntime(input)), expected);
    input.source.additionalRepositories.reverse();
    input.source.repository = 'EXAMPLE/PROJECT';
    assert.equal(compileConfiguration(input).setupDigest, expected.setupDigest);
    input.revision = 'another-revision';
    assert.equal(compileConfiguration(input).setupDigest, expected.setupDigest);
    assert.notEqual(compileConfiguration(input).artifactDigest, expected.artifactDigest);
    input.instructions += ' Changed requirement.';
    assert.notEqual(compileConfiguration(input).setupDigest, expected.setupDigest);
  }
});

test('reject executable, lossy, cyclic, oversized or non-Unicode inputs without invoking user code', () => {
  let called = 0;
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const evil = Object.defineProperty({}, 'key', { enumerable: true, get: () => { called++; return 'secret'; } });
  for (const input of [evil, new Proxy({}, { ownKeys: () => { called++; return []; } }), cycle,
    { toJSON: () => { called++; } }, [undefined], new Array(3), NaN, Infinity, new Date(), '\ud800', { ['\udfff']: 1 }, 'x'.repeat(1048577)]) {
    assert.throws(() => canonicalJson(input), ConfigurationError);
  }
  assert.equal(called, 0);
});

test('ambiguous syntax, duplicate JSON keys, YAML tags and coercions cannot change validated meaning', () => {
  for (const input of ['id: a\nid: b', 'id: &ref a\nrevision: *ref', 'id: !!str a', 'id: {<<: {x: 1}}',
    'id: 0x12', 'id: .inf', 'id: 01', 'id: True', 'id:\n', 'id: a\n---\nid: b']) {
    assert.throws(() => compileConfigurationText(input, 'yaml'), ConfigurationError);
  }
  const json = JSON.stringify(fixture()).replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2');
  assert.throws(() => compileConfigurationText(json, 'json'), ConfigurationError);
});

test('secret values, cross-organization grants, duplicate grants and invalid budgets are rejected', () => {
  const cases: unknown[] = [];
  cases.push({ ...fixture(), privateKey: 'sentinel-secret-that-must-not-appear' });
  const duplicate = fixture();
  duplicate.source.additionalRepositories.push({ repository: 'EXAMPLE/PROJECT', permissions: { contents: 'read' } }); cases.push(duplicate);
  const crossOrg = fixture();
  crossOrg.source.additionalRepositories.push({ repository: 'other/private', permissions: { contents: 'read' } }); cases.push(crossOrg);
  const badBudget = fixture(); badBudget.limits.maxCostMicrousdPerMonth = 1; cases.push(badBudget);
  const unknownField = { ...fixture(), harness: { ...fixture().harness, apiKey: 'sentinel-secret-that-must-not-appear' } }; cases.push(unknownField);
  for (const input of cases) {
    assert.throws(() => compileConfiguration(input), error => error instanceof ConfigurationError && !error.message.includes('sentinel'));
  }
});

test('all declared meaningful leaf values are validated or change the setup digest', () => {
  const original = fixture();
  const base = compileConfiguration(original).setupDigest;
  function paths(value: unknown, prefix: string[] = []): string[][] {
    if (typeof value !== 'object' || value === null) return [prefix];
    return Object.entries(value).flatMap(([key, item]) => paths(item, [...prefix, key]));
  }
  for (const path of paths(original).filter(path => path[0] !== 'revision')) {
    const changed = structuredClone(original) as unknown as Record<string, any>;
    let parent = changed;
    for (const part of path.slice(0, -1)) parent = parent[part];
    const key = path.at(-1)!;
    const value = parent[key];
    parent[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : value + '-change';
    try { assert.notEqual(compileConfiguration(changed).setupDigest, base, path.join('.')); }
    catch (error) { if (!(error instanceof ConfigurationError)) throw error; }
  }
});

test('schema diagnostics identify the authored value without exposing its contents', () => {
  const input = fixture();
  input.limits.timeoutMinutes = 'SENTINEL_PRIVATE_VALUE' as unknown as number;
  for (const format of ['json', 'yaml'] as const) {
    const source = format === 'json' ? JSON.stringify(input, null, 2) : stringify(input);
    const offset = source.indexOf(format === 'json' ? '"SENTINEL_PRIVATE_VALUE"' : 'SENTINEL_PRIVATE_VALUE');
    const prefix = source.slice(0, offset).split('\n');
    assert.throws(() => compileConfigurationText(source, format), error => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, 'SCHEMA');
      assert.equal(error.pointer, '/limits/timeoutMinutes');
      assert.deepEqual(error.location, { line: prefix.length, column: prefix.at(-1)!.length + 1 });
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  }
});

test('a consumer names every durable trace, so the runtime itself names none', async () => {
  const { consumerNames } = await import('../src/runtime/consumer.js');
  const { githubConsumerNames } = await import('../src/providers/github-names.js');
  const consumer = { name: 'sample-app', displayName: 'Sample App' };
  assert.deepEqual(consumerNames(consumer), { branchPrefix: 'sample-app', authorName: 'Sample App' });
  // Names only a GitHub adapter needs are derived by that adapter, from the same identity.
  const github = githubConsumerNames(consumer);
  assert.deepEqual([github.workflowPath, github.ledgerEnvironment, github.reserveTask, github.authorEmail],
    ['.github/workflows/sample-app.yml', 'sample-app-reservations', 'sample-app:reserve', 'sample-app@users.noreply.github.com']);
  for (const bad of ['', 'Upper', 'a--b', '-a', 'a/b', 'x'.repeat(40)]) {
    assert.throws(() => consumerNames({ name: bad, displayName: 'Ok' }), /consumer name/, bad);
    assert.throws(() => githubConsumerNames({ name: bad, displayName: 'Ok' }), /consumer name/, bad);
  }
  assert.throws(() => consumerNames({ name: 'ok', displayName: '<script>' }), /display name/);
});
