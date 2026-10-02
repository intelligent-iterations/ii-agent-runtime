import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { commitHubFiles } from '../src/hub-setup.js';
import { createProgress } from '../src/progress.js';
import { checkModelKey, ModelKeyError } from '../src/model-key.js';
import { explainRefusal, finishedMessage } from '../src/hub-messages.js';
import { compileConfiguration } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { fixture } from './runtime-fixture.js';
import { LEGACY_LAYOUT } from '../src/identity.js';

test('the hub configuration is one commit of only the changed files, and no commit when nothing changed', async () => {
  const blob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
  const writes: Array<{ route: string; body: any }> = [];
  const api: GitHubApi = { requests: 0, async request(method, path, body) {
    if (method !== 'GET') writes.push({ route: `${method} ${path}`, body });
    if (path.endsWith('/git/ref/heads/main')) return { status: 200, requestId: null, body: { object: { sha: 'a'.repeat(40) } } };
    if (path.includes('/git/commits/')) return { status: 200, requestId: null, body: { tree: { sha: 't'.repeat(40) } } };
    if (path.includes('/git/trees/')) return { status: 200, requestId: null, body: { truncated: false, tree: [{ path: 'same.json', sha: blob('same') }, { path: 'old.json', sha: blob('old') }] } };
    if (method === 'POST' && path.endsWith('/git/trees')) return { status: 201, requestId: null, body: { sha: 'n'.repeat(40) } };
    if (method === 'POST' && path.endsWith('/git/commits')) return { status: 201, requestId: null, body: { sha: 'c'.repeat(40) } };
    if (method === 'PATCH') return { status: 200, requestId: null, body: {} };
    throw Error(`Unexpected ${method} ${path}`);
  } };
  assert.equal(await commitHubFiles(api, 'example/software-factory', 'main', { 'same.json': 'same' }, 'noop'), false);
  assert.equal(writes.length, 0);
  assert.equal(await commitHubFiles(api, 'example/software-factory', 'main', { 'same.json': 'same', 'old.json': 'new' }, 'update'), true);
  assert.deepEqual(writes.map(write => write.route), ['POST /repos/example/software-factory/git/trees', 'POST /repos/example/software-factory/git/commits', 'PATCH /repos/example/software-factory/git/refs/heads/main']);
  assert.deepEqual(writes[0]!.body.tree.map((entry: any) => entry.path), ['old.json']);
  assert.deepEqual(writes[1]!.body.parents, ['a'.repeat(40)]);
  writes.length = 0;
  assert.equal(await commitHubFiles(api, 'example/software-factory', 'main', { 'same.json': 'same', 'old.json': 'user edits kept' }, 'rerun', path => path === 'old.json'), false,
    'a file the user may have edited is never replaced');
  assert.equal(writes.length, 0);
});

test('progress says what is running, how far along it is, and when GitHub is the slow part', () => {
  let clock = 0, output = '';
  const tty = createProgress({ write: (text: string) => { output += text; }, isTTY: true }, { now: () => clock, heartbeatMs: 1000000, quietMs: 10000, color: false });
  const task = tty.task('Checking repositories', 100);
  for (let i = 0; i < 20; i++) { clock += 500; task.tick(`example/repo-${i}`); }
  assert.match(output, /Checking repositories · 20\/100 · example\/repo-19 · about 40s left/);
  clock += 12000; tty.line('x');
  assert.match(output, /still waiting on GitHub \(12s\)/);
  task.note('· example/empty: skipped');
  assert.match(output, /\x1b\[2K {2}· example\/empty: skipped\n/);
  task.done('100 repositories checked');
  assert.match(output, /✓ 100 repositories checked\n$/);
  let plain = '';
  const pipe = createProgress({ write: (text: string) => { plain += text; }, isTTY: false });
  pipe.task('Saving', 2).done('Saved');
  assert.equal(plain, 'Saving (2)...\n✓ Saved\n');
});

test('an OpenAI key pasted twice, with spaces, or as two keys is refused before it can be stored', () => {
  const key = `sk-proj-${'a1B2'.repeat(10)}`;
  assert.equal(checkModelKey(` ${key}\n`).value, key);
  assert.equal(checkModelKey(key).preview, `sk-proj-...a1B2 (${key.length} characters)`);
  assert.match(checkModelKey('x'.repeat(10) + 'y'.repeat(20)).warning ?? '', /usually start with "sk-"/);
  for (const [raw, message] of [[key + key, /pasted twice/], [`${key} ${key.slice(0, 10)}`, /spaces or line breaks/], [`${key}sk-other1234567890`, /more than one key/], ['', /No key/], ['sk-short', /length/]] as const) {
    assert.throws(() => checkModelKey(raw), (error: unknown) => error instanceof ModelKeyError && message.test(error.message), raw);
  }
});

test('every refusal on a hub issue says what to do next', () => {
  const config = compileConfiguration({ ...fixture(), launchPolicy: { mode: 'maintainer-approval', minimumPermission: 'write', label: 'agent:run' } }).configuration;
  assert.equal(explainRefusal('approval-required', 'example/project', config), 'Waiting for someone with write access to `example/project` to add the `agent:run` label.');
  assert.match(explainRefusal('concurrency-limit', 'example/project', config), /1 agent is already running.*Remove and re-add the `agent:run` label/,
    'in approval mode the approver retries; a reopen would never start an agent');
  const authorConfig = compileConfiguration(fixture()).configuration;
  assert.match(explainRefusal('concurrency-limit', 'example/project', authorConfig), /Close and reopen this issue/);
  assert.match(explainRefusal('monthly-cost-limit', 'example/project', config), /\$20\.00.*maxCostMicrousdPerMonth` in `\.software-factory\/policy\.json`/);
  // A hub made under the earlier name keeps its policy where it is, and its replies say so.
  assert.equal(explainRefusal('disabled', 'example/project', config, LEGACY_LAYOUT.policyPath), 'Software Factory is paused: `limits.enabled` is `false` in `.agent-factory/policy.json`.');
  assert.match(finishedMessage('example/project', { status: 'worker-completed', push: { verified: true, branch: 'b', base: 'main', commits: 0, files: 0 } }, 'https://run',
    LEGACY_LAYOUT.policyPath), /`harness\.model` in `\.agent-factory\/policy\.json`/);
  assert.match(explainRefusal('something-new', 'example/project', config), /not started \(something-new\)/);
  assert.match(explainRefusal('subject-limit', 'example/project', config), /This issue already used its 1 agent run\. Open a new issue/);
  assert.match(finishedMessage('example/project', { status: 'worker-completed', push: { verified: true, branch: 'software-factory/issue-3-run-9', base: 'main', commits: 1, files: 1 } }, 'https://run'),
    /pushed 1 commit changing 1 file to \[`software-factory\/issue-3-run-9`\]\(https:\/\/github.com\/example\/project\/tree\/software-factory\/issue-3-run-9\)/);
  assert.match(finishedMessage('example/project', { status: 'worker-completed', push: { verified: true, branch: 'b', base: 'dev', commits: 1, files: 2 },
    changeRequest: { number: 4, url: 'https://github.com/example/project/pull/4' } }, 'https://run'), /opened \[pull request #4\]\(https:\/\/github.com\/example\/project\/pull\/4\) into `dev`/);
  assert.match(finishedMessage('example/project', { status: 'worker-completed', push: { verified: true, branch: 'b', base: 'main', commits: 0, files: 0 } }, 'https://run'), /without pushing any changes/);
  assert.match(finishedMessage('example/project', { status: 'worker-completed', push: { verified: false } }, 'https://run'), /finished, but what it pushed could not be checked/,
    'an unverifiable push is never reported as work');
  assert.match(finishedMessage('example/project', { status: 'failed' }, 'https://run'), /did not complete \(failed\)/);
});

test('a run that pushed nothing explains itself with the agent\'s own account, never command arguments', () => {
  const report = { status: 'worker-completed', push: { verified: true, branch: 'b', base: 'dev', commits: 0, files: 0 },
    worker: { activity: { commands: 5, failed: [{ program: 'rg', exitCode: 127 }, { program: 'rg', exitCode: 127 }, { program: 'flutter', exitCode: 127 }], messages: 2,
      lastMessage: 'I could not search the code: rg is not installed.\nStopping.', errors: [] } } };
  const text = finishedMessage('example/project', report, 'https://run');
  assert.match(text, /\*\*What the agent did:\*\* Ran 5 commands; failed: `rg` \(exit 127, a command was not found\), `flutter` \(exit 127, a command was not found\)\./);
  assert.match(text, /> I could not search the code: rg is not installed\.\n> Stopping\./);
  const opened = finishedMessage('example/project', { ...report, push: { ...report.push, commits: 1, files: 1 }, changeRequest: { number: 4, url: 'https://github.com/example/project/pull/4' } }, 'https://run');
  assert.match(opened, /^The agent opened \[pull request #4\]/);
  assert.match(opened, /<details><summary>What the agent did<\/summary>/, 'a successful run keeps its account collapsed');
  assert.match(finishedMessage('example/project', { ...report, setup: { label: 'npm ci', exitCode: 0, seconds: 23, timedOut: false } }, 'https://run'),
    /\*\*What the agent did:\*\* Installed dependencies with `npm ci` \(23 s\) before the agent started\.\nRan 5 commands/);
  assert.match(finishedMessage('example/project', { ...report, setup: { label: 'npm ci', exitCode: -1, seconds: 600, timedOut: true } }, 'https://run'),
    /Installing dependencies with `npm ci` timed out; the agent worked without them\./);
});
