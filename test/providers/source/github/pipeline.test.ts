import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPullRequest } from '../../../../src/providers/source/github/pipeline.js';
import { ChangeRequestRefused } from '../../../../src/pipeline/index.js';
import type { GitHubApi } from '../../../../src/providers/source/github/http.js';

test('a refused pull request keeps GitHub\'s status and short reason, stripped of markup', async () => {
  const api = { request: async (method: string) => method === 'POST'
    ? { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'No commits between main and `b` <x>' }] } }
    : { status: 200, body: [] } } as unknown as GitHubApi;
  await assert.rejects(openPullRequest(api, 'example/sample-project', { branch: 'b', base: 'main', title: 't', body: 'b' }), (error: unknown) => {
    assert.ok(error instanceof ChangeRequestRefused);
    assert.equal(error.status, 422);
    assert.equal(error.reason, 'Validation Failed: No commits between main and b x');
    return true;
  });
});
