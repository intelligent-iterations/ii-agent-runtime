import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { preflight } from '../src/onboarding-checks.js';

const api = (routes: Record<string, () => Response>) => createGitHubApi({ credential: () => 'synthetic-token', fetch: async url => {
  const path = new URL(String(url)).pathname;
  const route = routes[path];
  return route ? route() : new Response('{}', { status: 404 });
} });

test('onboarding checks membership and the installation inventory before anything is created, and says how to fix a missing scope', async () => {
  const owner = { '/user/memberships/orgs/example': () => Response.json({ state: 'active', role: 'admin' }),
    '/orgs/example/installations': () => Response.json({ installations: [] }), '/orgs/example': () => Response.json({ id: 7, plan: { name: 'team' } }) };
  assert.deepEqual(await preflight(api(owner), 'example'), { owner: true, free: false, id: 7 });
  await assert.rejects(preflight(api({ ...owner, '/orgs/example/installations': () => new Response('{}', { status: 403 }) }), 'example'), /admin:org/);
  await assert.rejects(preflight(api({ '/user/memberships/orgs/example': () => new Response('{}', { status: 404 }) }), 'example'), /read:org/);
  await assert.rejects(preflight(api({ '/user/memberships/orgs/example': () => Response.json({ state: 'pending', role: 'member' }) }), 'example'), /active membership/);
  await assert.rejects(preflight(api(owner), 'bad name'), /Invalid organization/);
});
