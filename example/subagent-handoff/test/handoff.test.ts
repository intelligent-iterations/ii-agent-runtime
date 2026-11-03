import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitToolSession, analyzeInvocations, createToolSession, preflightTools } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { openWorkerGateway } from '@intelligent-iterations/ii-agent-runtime/tools';
import { scriptedCoder, scriptedModel, scriptedPlanner } from '../src/model.js';
import { DEFAULT_TASK, loadConfig } from '../src/config.js';
import { buildControl, CODER, describeSystem, PLANNER, route, summarize, TASK_EVENT, testFile } from '../src/system.js';
import { HANDOFF_EVENT, projectFiles, workspaceTools } from '../src/workspace.js';
import { agentEnvironment, runHandoff } from '../src/workflow.js';

const NAME = 'sample-cart';
const SOURCES = ['src/cart.js', 'src/currency.js'];
const sample = fileURLToPath(new URL('../sample/', import.meta.url));
const withCopy = async (body: (root: string, read: (path: string) => string) => Promise<void> | void) => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-handoff-test-'));
  try {
    cpSync(sample, root, { recursive: true });
    await body(root, path => readFileSync(join(root, path), 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
};
const scripted = (subject: string) => subject === CODER ? scriptedCoder(NAME, 'test') : scriptedPlanner(NAME, 'test');
const options = (root: string) => ({ root, task: 'Fix the failing test.', testScript: 'test', model: 'scripted', signal: new AbortController().signal });
const calls = (steps: { tool: string; status: number }[]) => steps.map(step => `${step.tool}:${step.status}`);

test('analysis warns the planner can reach the coder\'s writes, and restriction shrinks that authority', () => withCopy(root => {
  const files = projectFiles(root);
  assert.deepEqual(files, ['package.json', 'src/cart.js', 'src/currency.js', 'test/cart.test.js']);
  const tools = workspaceTools({ root, name: NAME, onHandoff: () => 'unused' });
  const exposure = (coderWritablePaths?: string[]) => summarize(analyzeInvocations(describeSystem(tools,
    { name: NAME, files, testScript: 'test', ...(coderWritablePaths ? { coderWritablePaths } : {}) }).catalog));
  const broad = exposure(), restricted = exposure(SOURCES);
  assert.match(broad.message!, /planner can potentially activate coder via handoff-to-coder; write-file is indirectly reachable \(declared\)/);
  assert.equal(broad.directWrites, 0);
  assert.deepEqual(broad.reachableWrites, files);
  assert.equal(broad.notes.length, 2);
  // The handoff path remains; only the reachable authority shrinks.
  assert.match(restricted.message!, /planner can potentially activate coder/);
  assert.equal(restricted.directWrites, 0);
  assert.deepEqual(restricted.reachableWrites, SOURCES);
  assert.deepEqual(restricted.reachableScripts, ['test']);
  assert.deepEqual(restricted.notes, []);
  assert.throws(() => describeSystem(tools, { name: NAME, files, testScript: 'test', coderWritablePaths: ['src/missing.js'] }), /existing project files/);
}));

test('declared invokers drive routing: only matching events activate an agent', () => withCopy(root => {
  const tools = workspaceTools({ root, name: NAME, onHandoff: () => 'unused' });
  const { catalog } = describeSystem(tools, { name: NAME, files: projectFiles(root), testScript: 'test' });
  assert.deepEqual(route(catalog, TASK_EVENT, { project: NAME }), [PLANNER]);
  assert.deepEqual(route(catalog, HANDOFF_EVENT, { project: NAME }), [CODER]);
  assert.deepEqual(route(catalog, HANDOFF_EVENT, { project: 'another-project' }), []);
  assert.deepEqual(route(catalog, 'unrelated.event', { project: NAME }), []);
}));

test('restricted handoff fixes the failing test; out-of-scope writes are denied by the gateway', () => withCopy(async (root, read) => {
  const before = { test: read('test/cart.test.js'), manifest: read('package.json'), currency: read('src/currency.js') };
  const result = await runHandoff({ ...options(root), coderWritablePaths: SOURCES, models: scripted,
    probe: ['test/cart.test.js', 'package.json', 'src/currency.js'] });
  assert.equal(result.before, 1);
  assert.equal(result.after, 0);
  assert.deepEqual(calls(result.planner.steps), ['run-script:200', 'read-file:200', 'read-file:200', 'handoff-to-coder:200']);
  assert.equal(result.planner.steps[0]!.exitCode, 1);
  assert.deepEqual(result.handoff!.routedTo, [CODER]);
  assert.deepEqual(result.handoff!.grantedFiles, ['src/cart.js']);
  assert.deepEqual(calls(result.coder!.steps), ['read-file:200', 'write-file:200', 'run-script:200']);
  assert.equal(result.coder!.steps[2]!.exitCode, 0);
  assert.match(read('src/cart.js'), /sum \+ item\.priceCents \* item\.quantity/);
  // Probes re-write current content, so even an unexpected success could not alter the project.
  assert.deepEqual(result.probes, [
    { path: 'test/cart.test.js', status: 403, unchanged: true },
    { path: 'package.json', status: 403, unchanged: true },
    { path: 'src/currency.js', status: 403, unchanged: true },
  ]);
  assert.deepEqual({ test: read('test/cart.test.js'), manifest: read('package.json'), currency: read('src/currency.js') }, before);
}));

test('broad setup completes the same handoff, reporting the wider reachable authority', () => withCopy(async root => {
  const result = await runHandoff({ ...options(root), models: scripted });
  assert.equal(result.after, 0);
  assert.equal(result.exposure.reachableWrites.length, 4);
  assert.deepEqual(result.handoff!.grantedFiles, ['src/cart.js']);
}));

test('a handoff naming files outside the coder\'s bound is refused and the coder never starts', () => withCopy(async (root, read) => {
  const manifest = read('package.json');
  let turns = 0;
  const planner = scriptedModel((_request, turn) => ++turns === 1
    ? [{ type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, name: 'handoff-to-coder', status: 'completed',
      arguments: JSON.stringify({ project: NAME, summary: 'Change the test command', plan: 'Edit package.json scripts.test.', files: ['package.json'] }) }]
    : [{ type: 'message', id: `msg_${turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }]);
  let coderStarted = false;
  const result = await runHandoff({ ...options(root), coderWritablePaths: SOURCES,
    models: subject => { if (subject === CODER) coderStarted = true; return planner; } });
  assert.deepEqual(result.handoff!.refusedFiles, ['package.json']);
  assert.deepEqual(result.handoff!.grantedFiles, []);
  assert.equal(result.coder, undefined);
  assert.equal(coderStarted, false);
  assert.equal(result.after, 1);
  assert.equal(read('package.json'), manifest);
}));

test('the planner gateway exposes no write tool and denies writes; agents receive no keys', () => withCopy(async root => {
  const signal = new AbortController().signal, deadlineMs = Date.now() + 60000;
  const tools = workspaceTools({ root, name: NAME, onHandoff: () => 'unused' });
  const system = describeSystem(tools, { name: NAME, files: projectFiles(root), testScript: 'test' });
  let resolutions = 0;
  const session = createToolSession({ subject: PLANNER, tools: [...tools.values()], grants: system.grants[PLANNER],
    context: { executionId: 'test', attemptId: '1', inputDigest: 'sha256:test', deadlineMs, signal },
    resolveCredential: async () => { resolutions++; return { values: { handle: 'local-handle-never-returned' }, expiresAt: deadlineMs }; } });
  admitToolSession(session, await preflightTools(session, { inspectors: [], signal }), []);
  const gateway = await openWorkerGateway({ address: '127.0.0.1', grants: [], tools: session, signal,
    model: { respond: async () => new Response(null, { status: 403 }) } });
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  const post = (tool: string, input: unknown) => fetch(`${gateway.endpoint}/tools/${tool}`, { method: 'POST', headers, body: JSON.stringify(input) });
  try {
    const names = (await (await fetch(`${gateway.endpoint}/tools`, { headers })).json()).map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, ['handoff-to-coder', 'list-files', 'read-file', 'run-script']);
    assert.equal((await post('write-file', { project: NAME, path: 'src/cart.js', content: '' })).status, 403);
    assert.equal((await post('run-script', { project: NAME, script: 'build' })).status, 403);
    assert.equal((await post('read-file', { project: NAME, path: '../outside' })).status, 400);
    assert.equal((await post('read-file', { project: NAME, path: 'src/../package.json' })).status, 403);
    assert.equal((await post('read-file', { project: 'another-project', path: 'src/cart.js' })).status, 403);
    assert.equal((await fetch(`${gateway.endpoint}/tools`)).status, 403);
    assert.equal(resolutions, 0);
    const read = await (await post('read-file', { project: NAME, path: 'src/cart.js' })).text();
    assert.match(read, /cartTotal/);
    assert.ok(!read.includes('local-handle-never-returned'));
    assert.equal(resolutions, 1);
  } finally { await gateway.close(); }
  assert.deepEqual(Object.keys(agentEnvironment()), ['PATH']);
}));

test('agents never see hidden or key files at any depth', () => withCopy(root => {
  for (const path of ['apps/api/.env', '.github/workflows/ci.yml', 'certs/server.pem', 'src/.cache/x.js']) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'secret');
  }
  assert.deepEqual(projectFiles(root), ['package.json', 'src/cart.js', 'src/currency.js', 'test/cart.test.js']);
}));

test('analysis notes cover default test runner file names and tool configs', () => {
  for (const path of ['test.js', 'lib/links_test.js', 'lib/links-test.mjs', 'lib/test-links.js', 'src/a.spec.ts', '__tests__/a.js'])
    assert.ok(testFile.test(path), path);
  for (const path of ['src/contest.js', 'src/latest.js', 'src/testing.js']) assert.ok(!testFile.test(path), path);
  for (const path of ['package.json', 'apps/web/package.json', 'jest.config.js', 'vitest.config.mts', 'tsconfig.build.json', 'pnpm-lock.yaml'])
    assert.ok(buildControl.test(path), path);
  assert.ok(!buildControl.test('src/config.js'));
});

test('config problems are listed together; the key is checked last and only for live runs', () => withCopy(root => {
  const config = join(root, '..', `handoff-config-${process.pid}.json`);
  const write = (value: unknown) => writeFileSync(config, JSON.stringify(value));
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    write({ project: root, testScript: 'tset', coderWritablePaths: ['./src/cart.js', 'src/*.js', 'src', 'cart.js'], model: 'YOUR_MODEL' });
    assert.throws(() => loadConfig(config, { live: false, broad: false }), (error: Error) =>
      /4 problem/.test(error.message) && /"tset" is not a script/.test(error.message) && /pattern/.test(error.message) &&
      /directory/.test(error.message) && /did you mean src\/cart\.js/.test(error.message) && !/OPENAI_API_KEY/.test(error.message));
    assert.throws(() => loadConfig(config, { live: true, broad: false }), (error: Error) =>
      /8 problem/.test(error.message) && /OPENAI_API_KEY is not set/.test(error.message.split('\n').at(-1)!));
    write({ project: root, coderWritablePaths: ['./src/cart.js'] });
    const loaded = loadConfig(config, { live: false, broad: false });
    assert.deepEqual(loaded.writable, ['src/cart.js']); assert.equal(loaded.task, DEFAULT_TASK);
    mkdirSync(join(root, 'tools', 'subagent-handoff'), { recursive: true });
    assert.throws(() => loadConfig(config, { live: false, broad: false, exampleRoot: join(root, 'tools', 'subagent-handoff') }),
      /this example folder is inside the project \(tools\/subagent-handoff\)/);
    assert.throws(() => loadConfig(join(root, 'missing.json'), { live: false, broad: false }), /Config file not found/);
  } finally { rmSync(config, { force: true }); if (key !== undefined) process.env.OPENAI_API_KEY = key; }
}));
