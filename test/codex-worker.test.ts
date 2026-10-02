import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { CODEX_WORKER_PROGRAM, executeCodexWorker } from '../src/providers/codex-worker.js';
import { compileConfiguration } from '../src/runtime/configuration.js';
import { fixture } from './runtime-fixture.js';

const worker = { owner: 'a'.repeat(32), containerId: 'b'.repeat(64), networkId: 'c'.repeat(64), directory: '/synthetic-owned-directory' };
const endpoint = 'http://127.0.0.1:12345';
const access = { remotePrefix: 'https://code.example/', gatewayPrefix: `${endpoint}/git/`, notes: 'The code host API is at the gateway.' };
const invocation = (task: { title: string; body: string }) => ({ compiled: compileConfiguration(fixture()), worker, endpoint, token: 'd'.repeat(64), timeoutMs: 10000,
  task: { reference: 'task-9', label: 'Task 9', ...task }, branch: 'sample-app/task-9-run-3', delivered: false,
  author: { name: 'Sample App', email: 'sample-app@example.com' }, access });
const reply = (payload: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, exitCode: 0, head: 'e'.repeat(40), dirty: false, branch: payload.branch });

test('worker bootstrap parses as JavaScript and task contents never become host command arguments or environment', async () => {
  new Script(CODEX_WORKER_PROGRAM);
  const task = { title: '$(do-not-run)', body: '`shell injection`\n${{ secrets.NOT_REAL }}\n"; process.exit(99); //' };
  const result = await executeCodexWorker(invocation(task), { process: async request => {
    assert.equal(request.command, 'docker');
    assert.ok(!JSON.stringify(request.args).includes(task.title));
    // Only a path and a home directory: no credential, configured or otherwise, reaches the host command.
    assert.deepEqual(Object.keys(request.env).sort(), ['HOME', 'PATH']);
    const payload = JSON.parse(String(request.input));
    assert.ok(payload.prompt.includes(task.body));
    assert.equal(payload.repository, fixture().source.repository);
    assert.equal(payload.branch, 'sample-app/task-9-run-3');
    assert.deepEqual([payload.authorName, payload.authorEmail], ['Sample App', 'sample-app@example.com']);
    assert.deepEqual([payload.remotePrefix, payload.gatewayPrefix], [access.remotePrefix, access.gatewayPrefix]);
    return JSON.stringify({ schemaVersion: 1, exitCode: 0, head: 'e'.repeat(40), dirty: true, branch: payload.branch });
  } });
  assert.equal(result.dirty, true);
  for (const unsafe of [{ endpoint: 'https://unexpected.example' }, { endpoint: 'http://user:pass@127.0.0.1:12345' },
    { access: { ...access, gatewayPrefix: 'http://elsewhere.example/git/' } }, { access: { ...access, remotePrefix: 'file:///' } },
    { branch: '../main' }, { author: { name: 'Sample App', email: 'not an address' } }]) {
    await assert.rejects(executeCodexWorker({ ...invocation(task), ...unsafe }, { process: async () => assert.fail('An invalid invocation must not invoke Docker') }));
  }
});

test('the worker creates CODEX_HOME before starting Codex, which otherwise exits without a model request', () => {
  const create = CODEX_WORKER_PROGRAM.indexOf("mkdirSync(home + '/codex'");
  assert.ok(create > 0);
  assert.ok(create < CODEX_WORKER_PROGRAM.indexOf("CODEX_HOME: home + '/codex'"));
  assert.ok(create < CODEX_WORKER_PROGRAM.indexOf("spawn('codex'"));
});

test('the prompt states only mechanism: the base branch, delivery when the pipeline delivers, setup, and the task; unsafe names never reach git', async () => {
  const base = invocation({ title: 'Title', body: 'Body' });
  let payload: Record<string, any> = {};
  const capture = { process: async (request: { input?: string | Buffer }) => { payload = JSON.parse(String(request.input)); return reply(payload); } };
  await executeCodexWorker({ ...base, base: 'dev', delivered: true }, capture);
  assert.equal(payload.base, 'dev');
  assert.match(payload.prompt, /Base branch: dev \(the task branch starts here; your pushed work is opened for review against it after you push\)/);
  assert.match(payload.prompt, /The code host API is at the gateway\.\n\nTask 9: Title\n\nBody$/);
  assert.doesNotMatch(payload.prompt, /pull request|GitHub|[Ii]ssue/, 'consumer and provider wording comes from the consumer and the source host');
  await executeCodexWorker({ ...base, base: 'dev' }, capture);
  assert.doesNotMatch(payload.prompt, /opened for review/, 'no delivery is promised when the pipeline does not deliver');
  assert.ok(!CODEX_WORKER_PROGRAM.includes("'clone'"), 'the worker never clones: the host checks out the base branch without giving the worker its token');
  assert.ok(CODEX_WORKER_PROGRAM.includes("throw Error('Repository not loaded')"));
  await executeCodexWorker({ ...base, setup: { label: 'npm ci', exitCode: 0 } }, capture);
  assert.match(payload.prompt, /Dependencies were installed before you started \(npm ci\)\. The network is now limited to this gateway/);
  for (const unsafe of ['-upload-pack=x', '../main', 'a b']) {
    await assert.rejects(executeCodexWorker({ ...base, base: unsafe }, { process: async () => assert.fail('an unsafe branch must not start the worker') }), /Invalid worker invocation/);
  }
});

test('the worker reports a content-free activity summary from Codex\'s real event stream', async () => {
  const { readFileSync } = await import('node:fs');
  const { EventEmitter } = await import('node:events');
  const { runInNewContext } = await import('node:vm');
  // Recorded from Codex CLI 0.159.2 exec --json: a failed `rg`, a file write, and a final message.
  const events = readFileSync(new URL('./fixtures/codex-0.159.2-exec-events.jsonl', import.meta.url), 'utf8');
  let written = '';
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
    stdin: Object.assign(new EventEmitter(), { end() {
      // Deliver the stream in awkward pieces, the way a pipe can.
      for (let at = 0; at < events.length; at += 97) child.stdout.emit('data', Buffer.from(events.slice(at, at + 97)));
      setImmediate(() => child.emit('close', 0));
    } }) });
  const done = new Promise<void>(resolve => {
    const fakeProcess = { stdin: (async function* () { yield JSON.stringify({ token: 'd'.repeat(64), version: '0.159.2', endpoint: 'http://127.0.0.1:1', repository: 'example/project', branch: 'sample-app/task-1-run-1', remotePrefix: 'https://code.example/', gatewayPrefix: 'http://127.0.0.1:1/git/', model: 'gpt-6-luna', prompt: 'task', timeoutMs: 60000 }); })(),
      stdout: { write(text: string) { written += text; resolve(); } }, stderr: { write(text: string) { written += text; resolve(); } }, exitCode: 0 };
    const fakeRequire = (name: string) => name === 'node:fs' ? { mkdirSync() {}, rmSync() {}, appendFileSync() {}, existsSync: () => true } : {
      execFileSync: (command: string, args: string[]) => Buffer.from(command === 'codex' ? 'codex-cli 0.159.2' : args.includes('rev-parse') ? 'e'.repeat(40) : ''),
      spawn: () => child };
    runInNewContext(CODEX_WORKER_PROGRAM, { require: fakeRequire, process: fakeProcess, Buffer, setTimeout, clearTimeout, setImmediate, JSON, String, Number, Promise, Error,
      AbortSignal, fetch: async () => { throw Error('No route to the internet'); } });
  });
  await done;
  const result = JSON.parse(written);
  assert.deepEqual(result.activity, { commands: 2, failed: [{ program: 'rg', exitCode: 1 }], messages: 1, lastMessage: 'I could not find the chat screen.', errors: [] });
  assert.ok(!written.includes('README.md'), 'command arguments and output never leave the worker');
});

test('the worker refuses to start Codex when the agent phase can reach the internet', async () => {
  const { runInNewContext } = await import('node:vm');
  let written = '';
  let spawned = false;
  await new Promise<void>(resolve => {
    const fakeProcess = { stdin: (async function* () { yield JSON.stringify({ token: 'd'.repeat(64), version: '0.159.2', endpoint: 'http://127.0.0.1:1', branch: 'b', model: 'm', prompt: 'p', timeoutMs: 60000 }); })(),
      stdout: { write(text: string) { written += text; resolve(); } }, stderr: { write(text: string) { written += text; resolve(); } }, exitCode: 0 };
    const fakeRequire = (name: string) => name === 'node:fs' ? { mkdirSync() {}, rmSync() {}, appendFileSync() {}, existsSync: () => true } : {
      execFileSync: (command: string) => Buffer.from(command === 'codex' ? 'codex-cli 0.159.2' : ''), spawn: () => { spawned = true; throw Error('must not start'); } };
    runInNewContext(CODEX_WORKER_PROGRAM, { require: fakeRequire, process: fakeProcess, Buffer, setTimeout, clearTimeout, setImmediate, JSON, String, Number, Promise, Error,
      AbortSignal, fetch: async () => new Response('reachable') });
  });
  assert.equal(written, 'Worker execution failed.');
  assert.equal(spawned, false);
});
