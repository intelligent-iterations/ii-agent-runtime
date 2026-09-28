import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareFactoryRepository } from '../src/onboarding-repository.js';
import type { WorkflowInstallationTransport } from '../src/workflow-installation.js';

test('factory onboarding requires an existing private App-installed repository', async () => {
  const requests: string[] = [];
  const transport: WorkflowInstallationTransport = { async request(method, path) {
    requests.push(`${method} ${path}`);
    return { status: 200, body: { private: true } };
  } };
  await prepareFactoryRepository('org/factory', transport);
  assert.deepEqual(requests, ['GET /repos/org/factory']);
});

test('factory onboarding refuses missing, public, or archived repositories without creating one', async () => {
  for (const response of [
    { status: 404, body: {} }, { status: 200, body: { private: false } },
    { status: 200, body: { private: true, archived: true } },
  ]) {
    let calls = 0;
    await assert.rejects(prepareFactoryRepository('org/factory', { async request() { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});
