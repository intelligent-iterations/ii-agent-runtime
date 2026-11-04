import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerNamespacePolicy } from '../../../../src/providers/execution/docker/namespace-policy.js';
import type { ProcessRequest } from '../../../../src/providers/shared/process.js';

const owner = 'a'.repeat(32);
const base = { owner, image: 'example/policy@sha256:' + 'b'.repeat(64), directory: '/trusted', environment: { PATH: '/usr/bin' } };

test('policy acquisition failure still reconciles its owned helper and kernel policy during cleanup', async () => {
  const calls: Array<{ request: ProcessRequest; cleanup: boolean }> = [];
  let present = true;
  const policy = dockerNamespacePolicy({ ...base, execute: async (request, cleanup) => {
    calls.push({ request, cleanup });
    if (request.args.at(-1) === 'add') throw Error('lost-provider-response');
    if (request.args[0] === 'ps' && present) return 'c'.repeat(64);
    if (request.args[0] === 'inspect') return JSON.stringify([{ Config: { Labels: { 'agent-runtime.owner': owner } } }]);
    if (request.args[0] === 'rm') present = false;
    return '';
  } });
  await assert.rejects(policy.create(), /lost-provider-response/);
  await policy.close(); await policy.close();
  assert.deepEqual(calls.map(call => call.request.args[0]), ['run', 'ps', 'inspect', 'rm', 'run', 'ps']);
  assert.ok(calls.slice(1).every(call => call.cleanup));
  const acquire = calls[0]!.request;
  assert.ok(acquire.args.includes('MAC_ADMIN'));
  assert.ok(!acquire.args.includes('--privileged'));
  assert.ok(acquire.args.includes('none'));
  assert.equal(acquire.input, `abi <abi/4.0>,\nprofile ${policy.profile} flags=(unconfined) { userns, }\n`);
});

test('cleanup refuses a helper whose ownership changed', async () => {
  const calls: string[] = [];
  const policy = dockerNamespacePolicy({ ...base, execute: async request => {
    calls.push(request.args[0]!);
    if (request.args[0] === 'ps') return 'c'.repeat(64);
    if (request.args[0] === 'inspect') return JSON.stringify([{ Config: { Labels: { 'agent-runtime.owner': 'another' } } }]);
    return '';
  } });
  await policy.create();
  await assert.rejects(policy.close(), /ownership changed/);
  assert.equal(calls.includes('rm'), false);
});

test('policy image and owner bindings are immutable and validated before effects', () => {
  const execute = async () => { throw Error('must not run'); };
  assert.throws(() => dockerNamespacePolicy({ ...base, execute, image: 'example/policy:latest' }));
  assert.throws(() => dockerNamespacePolicy({ ...base, execute, owner: '../other' }));
});
