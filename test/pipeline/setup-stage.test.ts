import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadWorkerSource, runWorkerSetup } from '../../src/providers/execution/docker/setup.js';
import type { ProcessRequest } from '../../src/providers/shared/process.js';

function ownedDirectory(t: { after(fn: () => void): void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-setup-')));
  const owner = randomBytes(16).toString('hex');
  writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(directory, '.owner'), 'utf8'), owner); rmSync(directory, { recursive: true }); });
  return { directory, owner, containerId: 'c'.repeat(64), networkId: 'd'.repeat(64) };
}

test('setup reaches the internet only through a guarded bridge, then is detached, emptied of its processes and removed', async t => {
  const worker = ownedDirectory(t);
  for (const fault of ['none', 'survivor', 'failed-install', 'timeout']) {
    const calls: ProcessRequest[] = [];
    const network = 'e'.repeat(64);
    const operation = runWorkerSetup(worker, ['npm ci --no-audit --no-fund'], { timeoutMs: 60000, process: async request => {
      calls.push(request);
      const [first, second] = request.args;
      if (first === 'network' && second === 'create') return `${network}\n`;
      if (first === 'network' && second === 'inspect') return JSON.stringify([{ Id: network, Labels: { 'agent-runtime.owner': worker.owner }, Internal: false,
        EnableIPv6: false, Options: { 'com.docker.network.bridge.name': `afs-${worker.owner.slice(0, 11)}` }, IPAM: { Config: [{ Gateway: '172.30.0.1' }] }, Containers: {} }]);
      if (first === 'exec' && request.args.includes('sh') && String(request.args.at(-1)).includes('agent-runtime-setup.log')) {
        if (fault === 'timeout') throw Error('Process deadline exceeded');
        return fault === 'failed-install' ? '1\n' : '0\n';
      }
      if (first === 'exec' && request.args.at(-1) === 'pid=,stat=,comm=') return fault === 'survivor' ? '1 S sleep\n 44 S node\n 51 R ps\n' : '1 S sleep\n 47 Z npm\n 51 R ps\n';
      return '';
    } });
    if (fault === 'survivor') await assert.rejects(operation, /cleanup unconfirmed/);
    else assert.deepEqual(await operation, { exitCode: fault === 'none' ? 0 : fault === 'failed-install' ? 1 : -1, seconds: 0, timedOut: fault === 'timeout' });
    const index = (match: (call: ProcessRequest) => boolean) => calls.findIndex(match);
    const connect = index(call => call.args[0] === 'network' && call.args[1] === 'connect');
    const install = index(call => String(call.args.at(-1)).includes('agent-runtime-setup.log'));
    const detach = index(call => call.args.includes('--force'));
    const kill = index(call => String(call.args.at(-1)).includes('kill -9'));
    const removeRule = index(call => call.args.includes('-D'));
    const remove = index(call => call.args[0] === 'network' && call.args[1] === 'rm');
    const denials = calls.slice(0, connect).filter(call => call.args.includes('-I'));
    // Host, private, link-local (cloud metadata) and IPv6 traffic is dropped before the worker joins.
    assert.equal(denials.length, 9);
    for (const range of ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) assert.ok(denials.some(call => call.args.includes(range)), range);
    assert.ok(connect < install && install < detach && detach < kill && kill < removeRule && removeRule < remove, fault);
    assert.equal(calls.filter(call => call.args.includes('-D')).length, 9);
    const setupCall = calls[install]!;
    assert.deepEqual(setupCall.args.slice(0, 3), ['exec', '--user', '10001:10001']);
    assert.ok(!JSON.stringify(setupCall).match(/TOKEN|token|KEY/), 'setup runs with no credential in its environment');
  }
  await assert.rejects(runWorkerSetup(worker, ['ok', 'bad\nnewline'], { timeoutMs: 1000, process: async () => assert.fail('must not run') }), /Invalid setup commands/);
});

test('the repository is copied into the worker as the worker user, from a host archive that is always removed', async t => {
  const worker = ownedDirectory(t);
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-source-')));
  t.after(() => rmSync(source, { recursive: true }));
  const calls: ProcessRequest[] = [];
  await loadWorkerSource(worker, source, { process: async request => {
    calls.push(request);
    if (request.command === 'tar') writeFileSync(request.args[3]!, 'archive');
    return '';
  } });
  assert.deepEqual(calls.map(call => call.command), ['tar', 'docker', 'docker']);
  assert.deepEqual(calls[2]!.args.slice(0, 4), ['exec', '--interactive', '--user', '10001:10001']);
  assert.equal(String(calls[2]!.input), 'archive');
  assert.throws(() => readFileSync(join(worker.directory, 'source.tar')), 'the archive does not outlive the copy');
});
