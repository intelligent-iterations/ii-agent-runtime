import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hubRequestReader, parseBaseBranch, parseTargetRepository } from '../src/hub-issue-form.js';

const form = (repository: string, task = 'Fix the sample') => `### Repository\n\n${repository}\n\n### Task\n\n${task}`;

test('the pull request branch comes from its own form field, defaults when empty, and refuses unsafe names', () => {
  const withBase = (value: string) => `### Repository\n\nmy-app\n\n### Pull request into\n\n${value}\n\n### Task\n\nFix it`;
  assert.equal(parseTargetRepository(withBase('dev'), 'example'), 'example/my-app', 'the new field does not disturb the target');
  assert.equal(parseBaseBranch(withBase('dev')), 'dev');
  assert.equal(parseBaseBranch(withBase('release/2026-10')), 'release/2026-10');
  assert.equal(parseBaseBranch(withBase('refs/heads/dev')), 'dev');
  assert.equal(parseBaseBranch(withBase('_No response_')), undefined);
  assert.equal(parseBaseBranch(form('my-app')), undefined, 'issues filed before the field existed use the default branch');
  for (const bad of ['-dev', '../main', 'a..b', 'dev.lock', 'dev/', 'has space', 'x'.repeat(201)]) assert.equal(parseBaseBranch(withBase(bad)), null, bad);
  assert.equal(parseBaseBranch(`${withBase('dev')}\n\n### Pull request into\n\nmain`), null, 'a second base heading is refused');
});

test('the issue form names a repository in the hub organization, or nothing', () => {
  assert.equal(parseTargetRepository(form('Project'), 'example'), 'example/project');
  assert.equal(parseTargetRepository(form('example/project'), 'example'), 'example/project');
  assert.equal(parseTargetRepository(form('https://github.com/Example/Project.git'), 'example'), 'example/project');
  assert.equal(parseTargetRepository('### Repository\r\n\r\n  project  \r\n\r\n### Task\r\n\r\nx', 'example'), 'example/project');
  // Anything that could show a reviewer one target while naming another is refused.
  for (const body of [form('other/project'), form('../secrets'), form('a b'), 'Please fix project', null, form('_No response_'),
    `<!--\n### Repository\n\nsecret-repo\n-->\n${form('project')}`, `${form('project')}\n\n### Repository\n\nsecret-repo`,
    `Intro text\n\n${form('project')}`, `### Repository\n\nproject\n\n## Repository\n\nsecret-repo\n\n### Task\n\nx`, form('<b>project</b>')]) {
    assert.equal(parseTargetRepository(body, 'example'), undefined, String(body));
  }
});

test('the hub reads both fields through one reader, as the runtime intake receives it', () => {
  const read = hubRequestReader('example');
  assert.deepEqual(read(`### Repository\n\nproject\n\n### Pull request into\n\ndev\n\n### Task\n\nFix it`), { repository: 'example/project', base: 'dev' });
  assert.deepEqual(read('Please fix project'), { repository: undefined, base: undefined });
});
