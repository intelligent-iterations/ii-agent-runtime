import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectGitHubRepositoryToken } from '../src/providers/github-token-audit.js';

test('installation token warns about other write-capable repositories', async () => {
  const calls: string[] = [];
  const audit = await inspectGitHubRepositoryToken('org/repo-a', async path => {
    calls.push(path);
    return { status: 200, body: { total_count: 3, repositories: [
      { full_name: 'org/repo-a', permissions: { push: true } },
      { full_name: 'org/repo-b', permissions: { push: true } },
      { full_name: 'org/repo-c', permissions: { push: false } },
    ] } };
  });
  assert.deepEqual(calls, ['/installation/repositories?per_page=100&page=1']);
  assert.equal(audit.tokenType, 'installation');
  assert.match(audit.warnings.join(' '), /org\/repo-b/);
  assert.doesNotMatch(audit.warnings.join(' '), /org\/repo-c/);
});

test('personal token reports broad classic scope without claiming proven effective write access', async () => {
  const audit = await inspectGitHubRepositoryToken('org/repo-a', async path =>
    path.startsWith('/installation/') ? { status: 404, body: null } : {
      status: 200, body: [{ full_name: 'org/repo-a', permissions: { push: true } }, { full_name: 'org/repo-b', permissions: { push: true } }],
      headers: { get: (name: string) => name === 'x-oauth-scopes' ? 'repo, read:user' : null },
    });
  assert.equal(audit.tokenType, 'personal-or-user');
  assert.match(audit.warnings.join(' '), /Classic PAT has broad repo scope/);
  assert.match(audit.warnings.join(' '), /possible write access outside org\/repo-a/);
  assert.match(audit.warnings.join(' '), /account rather than the token/);
});

test('inspection failure and incomplete pagination stay visible', async () => {
  const failed = await inspectGitHubRepositoryToken('org/repo-a', async () => { throw Error('secret bearer value'); });
  assert.equal(failed.status, 'incomplete');
  assert.doesNotMatch(JSON.stringify(failed), /secret bearer value/);
  const incomplete = await inspectGitHubRepositoryToken('org/repo-a', async () => ({ status: 200, body: { total_count: 2, repositories: [{ full_name: 'org/repo-a' }] } }));
  assert.equal(incomplete.status, 'incomplete');
  assert.match(incomplete.warnings.join(' '), /incomplete/);
});
