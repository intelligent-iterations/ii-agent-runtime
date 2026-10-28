import assert from 'node:assert/strict';
import { test } from 'node:test';
test('a consumer names every durable trace, within the application', async () => {
  const { consumerNames } = await import('../src/consumer.js');
  const { githubConsumerNames } = await import('../src/github-names.js');
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
