import { workerResources } from '../../../../src/pipeline/worker-resources.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { openshellTarget } from '../../../../src/providers/execution/openshell/target.js';
import { openshellPolicy, verifyOpenShellPolicy } from '../../../../src/providers/execution/openshell/policy.js';
import type { ProcessRequest } from '../../../../src/providers/shared/process.js';
import { compileConfiguration } from '../../../../src/runtime/configuration.js';
import { fixture } from '../../../runtime-fixture.js';

const configuration = () => compileConfiguration({ ...fixture(), environment: { ...fixture().environment, provider: 'openshell' } });

test('OpenShell policy admits exactly one enforced HTTP endpoint and refuses extra authority', () => {
  const { network_policies: _empty, ...sealed } = openshellPolicy();
  verifyOpenShellPolicy(stringify(sealed), openshellPolicy());
  const policy = openshellPolicy('10.0.0.2', 23456);
  verifyOpenShellPolicy(stringify(policy), policy);
  for (const change of [
    { ...policy, landlock: { compatibility: 'best_effort' } },
    { ...policy, process: { run_as_user: '0', run_as_group: '0' } },
    { ...policy, network_policies: { ...policy.network_policies, extra: { endpoints: [{ host: 'example.com', port: 443 }] } } },
    { ...policy, filesystem_policy: { ...policy.filesystem_policy, read_write: ['/'] } },
  ]) assert.throws(() => verifyOpenShellPolicy(stringify(change), policy), /differs/);
  const audit = structuredClone(policy);
  audit.network_policies.runtime_gateway!.endpoints[0]!.enforcement = 'audit';
  assert.throws(() => verifyOpenShellPolicy(stringify(audit), policy), /differs/);
  assert.throws(() => verifyOpenShellPolicy('version: 1\nversion: 2', policy), /Invalid/);
  assert.throws(() => openshellPolicy('127.0.0.1', 0), /Invalid/);
});

test('OpenShell lifecycle seals, connects only to the gateway, preserves bounded stdin, and confirms asynchronous cleanup', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-test-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const calls: ProcessRequest[] = [];
  let name = '', policy = openshellPolicy(), listReads = 0;
  const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2', configDirectory: '/trusted/config' }, wait: async () => {},
    process: async request => {
      calls.push(request);
      assert.equal(request.env.OPENSHELL_TELEMETRY_ENABLED, 'false');
      assert.ok(!JSON.stringify(request.env).includes('synthetic-per-run-token'));
      const a = request.args;
      if (a[0] === '--version') return 'openshell 0.1.2\n';
      if (a[0] === 'status') return JSON.stringify({ status: 'connected', version: '0.1.2' });
      if (a[0] === 'settings') return JSON.stringify({ sandbox: name, settings: { agent_policy_proposals_enabled: { value: 'false', scope: 'global' } } });
      if (a[1] === 'create') {
        name = a[a.indexOf('--name') + 1]!;
        assert.equal(name.length, 19);
        assert.ok(a.includes('--no-auto-providers'));
        assert.equal(a[a.indexOf('--approval-mode') + 1], 'manual');
        assert.ok(!a.includes('--provider'));
        return '{}';
      }
      if (a[0] === 'policy') { policy = JSON.parse(JSON.stringify((await import('yaml')).parse(readFileSync(a[a.indexOf('--policy') + 1]!, 'utf8')))); return ''; }
      if (a.includes('--policy-only')) return stringify(policy);
      if (a[1] === 'get') return JSON.stringify({ name, phase: 'Ready', current_policy_version: 1, configuration_admission: { state: 'accepted', policy_version: 1 } });
      if (a[1] === 'list') return JSON.stringify({ sandboxes: ++listReads === 1 ? [{ name }] : [], next_page_token: '' });
      if (a[1] === 'exec') {
        assert.ok(a.includes('--no-login-shell'));
        assert.ok(a.includes('--no-tty'));
        assert.equal(request.input, 'synthetic-per-run-token');
        assert.ok(!a.includes('synthetic-per-run-token'));
        return 'command output';
      }
      return '';
    } });
  const worker = await target.provision(workerResources(configuration()));
  const isolation = await worker.isolate();
  await isolation.connect(23456);
  assert.deepEqual(policy, openshellPolicy('10.0.0.2', 23456));
  const controller = new AbortController();
  assert.equal(await worker.run({ command: 'node', args: ['-e', 'code'], input: 'synthetic-per-run-token', timeoutMs: 4321, maxOutputBytes: 1234, signal: controller.signal }), 'command output');
  const execution = calls.find(call => call.args[1] === 'exec')!;
  assert.equal(execution.signal?.aborted, false);
  controller.abort();
  assert.equal(execution.signal?.aborted, true);
  assert.equal(execution.timeoutMs, 4321);
  assert.equal(execution.maxOutputBytes, 1234);
  await isolation.close();
  assert.deepEqual(policy, openshellPolicy());
  await target.close();
  assert.equal(listReads, 2);
  assert.deepEqual(readdirSync(parent), []);
});

test('OpenShell refuses unavailable and mismatched versions before creating any sandbox', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-version-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const version of ['openshell 0.1.1', 'openshell 0.1.20', 'missing']) {
    const calls: string[][] = [];
    const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2' }, process: async request => {
      calls.push(request.args);
      if (version === 'missing') throw Error('unavailable');
      return version;
    } });
    await assert.rejects(target.provision(workerResources(configuration())), /OpenShell.*(version mismatch|unavailable)/);
    await target.close();
    assert.deepEqual(calls, [['--version']]);
  }
});

test('OpenShell cleans up an uncertain create and never treats a failed cleanup read as proof', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-cleanup-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let deleted = false, creates = 0, name = '';
  const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2' }, process: async request => {
    const a = request.args;
    if (a[0] === '--version') return 'openshell 0.1.2';
    if (a[0] === 'status') return JSON.stringify({ status: 'connected', version: '0.1.2' });
    if (a[1] === 'create') { creates++; name = a[a.indexOf('--name') + 1]!; throw Error('Lost create response'); }
    if (a[1] === 'delete') { deleted = true; return ''; }
    if (a[1] === 'list') { if (!deleted) return JSON.stringify({ sandboxes: [{ name }] }); throw Error('Gateway unavailable'); }
    throw Error('Unexpected command');
  } });
  await assert.rejects(target.provision(workerResources(configuration())), /Lost create response/);
  // An uncertain attempt is still consumed: only the caller can start a new Run.
  await assert.rejects(target.provision(workerResources(configuration())), /session already used/);
  assert.equal(creates, 1, 'never automatically restart or replace the sandbox');
  await assert.rejects(target.close(), /Gateway unavailable/);
  assert.equal(deleted, true);
  assert.equal(readdirSync(parent).length, 1, 'retain ownership evidence when cleanup is not confirmed');
});


test('OpenShell refuses missing, nonnumeric or invalid activation versions', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-activation-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const [active, admitted] of [[undefined, undefined], [0, 0], ['1', '1'], [-1, -1], [1.5, 1.5], [NaN, NaN]]) {
    let name = '';
    const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2' }, process: async request => {
      const a = request.args;
      if (a[0] === '--version') return 'openshell 0.1.2';
      if (a[0] === 'status') return JSON.stringify({ status: 'connected', version: '0.1.2' });
      if (a[1] === 'create') { name = a[a.indexOf('--name') + 1]!; return '{}'; }
      if (a[0] === 'settings') return JSON.stringify({ sandbox: name, settings: { agent_policy_proposals_enabled: { value: 'false', scope: 'global' } } });
      if (a.includes('--policy-only')) return stringify(openshellPolicy());
      if (a[1] === 'get') return JSON.stringify({ name, phase: 'Ready', current_policy_version: active, configuration_admission: { state: 'accepted', policy_version: admitted } });
      if (a[1] === 'delete') return '';
      if (a[1] === 'list') return JSON.stringify({ sandboxes: [], next_page_token: '' });
      throw Error('Unexpected command');
    } });
    await assert.rejects(target.provision(workerResources(configuration())), /activation versions are invalid/);
    await target.close();
  }
});

test('OpenShell confirms deletion after a lost delete response and rejects commands after close', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-lost-delete-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let name = '', deleted = false, deleteCalls = 0;
  const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2' }, process: async request => {
    const a = request.args;
    if (a[0] === '--version') return 'openshell 0.1.2';
    if (a[0] === 'status') return JSON.stringify({ status: 'connected', version: '0.1.2' });
    if (a[1] === 'create') { name = a[a.indexOf('--name') + 1]!; return '{}'; }
    if (a[0] === 'settings') return JSON.stringify({ sandbox: name, settings: { agent_policy_proposals_enabled: { value: 'false', scope: 'global' } } });
    if (a.includes('--policy-only')) return stringify(openshellPolicy());
    if (a[1] === 'get') return JSON.stringify({ name, phase: 'Ready', current_policy_version: 1, configuration_admission: { state: 'accepted', policy_version: 1 } });
    if (a[1] === 'list') return JSON.stringify({ sandboxes: deleted ? [] : [{ name }] });
    if (a[1] === 'delete') { deleted = true; deleteCalls++; throw Error('Lost delete response'); }
    throw Error('Unexpected command');
  } });
  const worker = await target.provision(workerResources(configuration()));
  await Promise.all([target.close(), target.close()]);
  await target.close();
  assert.equal(deleteCalls, 1);
  await assert.rejects(worker.run({ command: 'node', args: [], timeoutMs: 1000, maxOutputBytes: 1000 }), /lifecycle state/);
  await assert.rejects(worker.load('/tmp'), /lifecycle state/);
  await assert.rejects(worker.isolate(), /lifecycle state/);
  assert.deepEqual(readdirSync(parent), []);
});

test('OpenShell rejects transitions during a live command and close cancels the command before deleting', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-cancel-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let name = '', deleted = false, canceled = false;
  const target = openshellTarget({ parent, executablePath: '/trusted/bin', host: { gatewayAddress: '10.0.0.2' }, process: async request => {
    const a = request.args;
    if (a[0] === '--version') return 'openshell 0.1.2';
    if (a[0] === 'status') return JSON.stringify({ status: 'connected', version: '0.1.2' });
    if (a[1] === 'create') { name = a[a.indexOf('--name') + 1]!; return '{}'; }
    if (a[0] === 'settings') return JSON.stringify({ sandbox: name, settings: { agent_policy_proposals_enabled: { value: 'false', scope: 'global' } } });
    if (a.includes('--policy-only')) return stringify(openshellPolicy());
    if (a[1] === 'get') return JSON.stringify({ name, phase: 'Ready', current_policy_version: 1, configuration_admission: { state: 'accepted', policy_version: 1 } });
    if (a[1] === 'list') return JSON.stringify({ sandboxes: deleted ? [] : [{ name }] });
    if (a[1] === 'delete') { assert.equal(canceled, true); deleted = true; return ''; }
    if (a[1] === 'exec') return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => { canceled = true; reject(Error('canceled')); }, { once: true }));
    throw Error('Unexpected command');
  } });
  const worker = await target.provision(workerResources(configuration()));
  const command = worker.run({ command: 'node', args: [], timeoutMs: 30000, maxOutputBytes: 1000 });
  const rejected = assert.rejects(command, /canceled/);
  await assert.rejects(worker.isolate(), /commands are still running/);
  await target.close();
  await rejected;
  assert.equal(deleted, true);
});
