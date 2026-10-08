import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, type PipelinePorts } from '../../src/pipeline/run.js';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { fixture } from '../runtime-fixture.js';

test('an unconfirmed setup seal prevents grants, gateway creation and agent execution, and still tears down the target', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const unused = async () => { assert.fail('authority must not open after setup seal failure'); };
  const config = fixture();
  const compiled = compileConfiguration({ ...config, environment: { ...config.environment, setup: { enabled: true, commands: ['npm ci'] } } });
  const ports: PipelinePorts = {
    consumer: { name: 'test', displayName: 'Test' },
    intake: { runId: 'seal-failure', attempt: 1, resource: 'test',
      authorize: async () => ({ allowed: true, reason: 'test', decision: {}, subjectId: 'test', inputDigest: 'test', task: { reference: 'test', label: 'Test', title: 'Test', body: 'Test' } }),
      confirm: unused, admit: async () => ({ allowed: true, reservationDigest: 'test', reservation: { schemaVersion: 1, resource: 'test', subjectId: 'test', runId: 'seal-failure', attempt: 1, inputDigest: 'test', policyDigest: 'test', createdAt: Date.now(), expiresAt: Date.now() + 60000, reservedMicrousd: 0 } }),
    },
    source: { name: 'source', target: 'test/repo', author: { name: 'test', email: 'test@example.com' },
      baseExists: unused, checkout: async () => ({ directory, dispose: async () => { calls.push('checkout-dispose'); } }),
      workerGrants: unused, workerAccess: () => { throw Error('unused'); }, canDeliver: () => false,
      verifyPush: unused, openChangeRequest: unused, close: async () => { calls.push('source-close'); },
    },
    target: { provision: async (_resources, context) => {
      assert.ok(context?.deadlineMs && context.signal);
      return { workspace: '/sandbox', load: async () => { calls.push('load'); }, run: unused, isolate: unused,
        setup: async () => { calls.push('setup'); throw Error('OpenShell setup process cleanup unconfirmed'); } };
    }, close: async () => { calls.push('target-close'); } },
    harness: { execute: unused }, model: { open: () => { throw Error('unused'); } }, gateway: unused,
    dispose: () => { calls.push('dispose'); },
  };
  const result = await runPipeline(compiled, ports);
  assert.equal(result.failed, true);
  assert.equal(result.report.phase, 'setup');
  assert.equal(result.report.status, 'failed');
  assert.deepEqual(calls, ['load', 'checkout-dispose', 'setup', 'source-close', 'target-close', 'dispose']);
});
