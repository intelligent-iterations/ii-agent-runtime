import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { createExecutionInputRecord } from '../../src/runtime/execution-inputs.js';
import { createCredentialResolver } from '../../src/runtime/credential-bindings.js';
import { inputs } from '../execution-input-fixture.js';

const binding = { provider: 'fixture-secrets', resource: 'fixture/project/environment', key: 'subscription-login', assignment: 'trusted-harness' };
const options = () => ({ deadlineMs: Date.now() + 10000, signal: new AbortController().signal });
function fixture() {
  const value = inputs(); value.configuration.credentialBindings = [binding]; value.credentials = [binding];
  const compiled = compileConfiguration(value.configuration);
  const record = createExecutionInputRecord(value, { executionId: 'run-1', attemptId: '1' });
  return { value, compiled, record };
}

test('only an approved, recorded reference reaches its selected provider with bound execution identity', async () => {
  const { compiled, record } = fixture(); let calls = 0;
  const handle = { read: async () => 'synthetic-private-value' };
  const resolver = createCredentialResolver(compiled, { id: binding.provider, resolve: async (reference, context) => {
    calls++; assert.ok(Object.isFrozen(reference)); assert.deepEqual(reference, binding);
    assert.equal(context.inputDigest, record.inputDigest); assert.equal(context.executionId, 'run-1');
    return handle;
  } });
  assert.equal(await resolver.resolve(record, binding, options()), handle); assert.equal(calls, 1);
  assert.equal(compiled.canonical.includes('synthetic-private-value'), false);
});

test('missing approval, another assignment/provider, altered records and cancellation deny before provider access', async () => {
  for (const fault of ['assignment', 'provider', 'record', 'unrecorded', 'cancel']) {
    const { value, compiled, record } = fixture(); let calls = 0;
    const resolver = createCredentialResolver(compiled, { id: fault === 'provider' ? 'another-provider' : binding.provider,
      resolve: async () => { calls++; return {}; } });
    let input = record;
    if (fault === 'record') input = { ...record, inputDigest: 'sha256:' + 'f'.repeat(64) };
    if (fault === 'unrecorded') { value.credentials = []; input = createExecutionInputRecord(value, record); }
    const context = options(); if (fault === 'cancel') context.signal = AbortSignal.abort();
    await assert.rejects(resolver.resolve(input, fault === 'assignment' ? { ...binding, assignment: 'another-harness' } : binding, context));
    assert.equal(calls, 0, fault);
  }
});

test('bindings affect configuration identity, normalize ordering, reject duplicates and never accept values', () => {
  const { value, compiled } = fixture();
  value.configuration.credentialBindings = [{ ...binding, assignment: 'reporter' }, binding];
  const first = compileConfiguration(value.configuration);
  value.configuration.credentialBindings.reverse(); assert.equal(compileConfiguration(value.configuration).canonical, first.canonical);
  assert.notEqual(first.setupDigest, compiled.setupDigest);
  value.configuration.credentialBindings.push(binding); assert.throws(() => compileConfiguration(value.configuration), /DUPLICATE_CREDENTIAL/);
  assert.throws(() => compileConfiguration({ ...compiled.configuration, credentialBindings: [{ ...binding, value: 'hidden' }] }));
});

test('provider errors cannot leak raw credential values through runtime failures', async () => {
  const { compiled, record } = fixture();
  const resolver = createCredentialResolver(compiled, { id: binding.provider, resolve: async () => { throw Error('synthetic-private-value'); } });
  await assert.rejects(resolver.resolve(record, binding, options()), error => error instanceof Error &&
    error.message.includes('CREDENTIAL_PROVIDER_FAILED') && !error.message.includes('synthetic-private-value'));
});
