import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutionTarget, workerResources, type ExecutionTarget } from '../../src/pipeline/index.js';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { fixture } from '../runtime-fixture.js';
import { declaration } from '../deployment/fixtures.js';

test('runtime execution requires no application trigger and never infers the caller as its target', async () => {
  const compiled = compileConfiguration(fixture());
  const host = { workParent: '/control-only', executablePath: '/control-only/bin' };
  assert.throws(() => createExecutionTarget(compiled, { host }), /explicit target/);
  const calls: string[] = [];
  const binding: ExecutionTarget = {
    provision: async resources => { calls.push(resources.image); throw Error('Provisioning test failure'); },
    close: async () => { calls.push('closed'); },
  };
  const target = createExecutionTarget(compiled, { host, executionTarget: binding });
  assert.equal(target, binding);
  try { await assert.rejects(target.provision(workerResources(compiled)), /Provisioning test failure/); }
  finally { await target.close(); }
  assert.deepEqual(calls, [compiled.configuration.environment.image, 'closed']);
});

test('runtime cloud selection rejects an execution override and requires explicit hosting', () => {
  const config = fixture(); const aws = declaration('aws');
  config.environment.hosting = { provider: 'aws', infrastructure: aws.infrastructure, providerConfiguration: aws.providerConfiguration,
    executorImage: 'example/executor@sha256:' + 'a'.repeat(64), ssh: { user: 'operator', identityFile: '/private/key', knownHostsFile: '/private/hosts' } };
  const compiled = compileConfiguration(config);
  const host = { workParent: '/control-only', executablePath: '/control-only/bin' };
  assert.doesNotThrow(() => createExecutionTarget(compiled, { host }));
  assert.throws(() => createExecutionTarget(compiled, { host, executionTarget: {
    provision: async () => { throw Error('unused'); }, close: async () => {},
  } }), /cannot override/);
  const missing = { ...compiled, configuration: { ...config, environment: { ...config.environment, hosting: undefined as never } } };
  assert.throws(() => createExecutionTarget(missing, { host }), /environment.hosting/);
});
