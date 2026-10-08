import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isolateWorkerNetwork } from '../../../../src/providers/execution/docker/network.js';
import type { ProcessRequest } from '../../../../src/providers/shared/process.js';

test('network joins only after IPv4/IPv6 denial and gateway allowance; cleanup disconnects before removing rules', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-network-')));
  const owner = randomBytes(16).toString('hex');
  writeFileSync(join(directory, '.owner'), owner, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(directory, '.owner'), 'utf8'), owner); rmSync(directory, { recursive: true }); });
  const worker = { directory, owner, containerId: 'c'.repeat(64), networkId: 'd'.repeat(64) };
  for (const fault of ['none', 'public-network', 'foreign-container', 'disconnect']) {
    const calls: ProcessRequest[] = [];
    let joined = false;
    const operation = isolateWorkerNetwork(worker, { process: async request => {
      calls.push(request);
      if (request.args[0] === 'network' && request.args[1] === 'connect') joined = true;
      // Before joining the worker has no network but none (or none at all, after dependency setup).
      if (request.args[0] === 'inspect' && !joined) return JSON.stringify([{ Id: worker.containerId, NetworkSettings: { Networks: fault === 'none' ? { none: {} } : {} } }]);
      if (request.args[0] === 'network' && request.args[1] === 'inspect') return JSON.stringify([{
        Id: worker.networkId, Labels: { 'agent-runtime.owner': owner }, Internal: fault !== 'public-network', EnableIPv6: false,
        Driver: 'bridge', IPAM: { Config: [{ Gateway: '172.28.0.1' }] }, Containers: {},
      }]);
      if (request.args[0] === 'inspect') return JSON.stringify([{ Id: fault === 'foreign-container' ? 'other' : worker.containerId,
        NetworkSettings: { Networks: { worker: { NetworkID: worker.networkId } } } }]);
      if (fault === 'disconnect' && request.args.includes('--force')) throw Error('Disconnect failed');
      return '';
    } });
    if (fault === 'public-network') { await assert.rejects(operation); assert.equal(calls.length, 1); continue; }
    const network = await operation;
    if (fault === 'foreign-container') await assert.rejects(network.connect(12345));
    else await network.connect(12345);
    const joinIndex = calls.findIndex(call => call.args[0] === 'network' && call.args[1] === 'connect');
    const installed = calls.slice(0, joinIndex).filter(call => call.args.includes('-I'));
    // none is detached only when attached; a worker already detached by setup joins directly.
    assert.equal(calls.some(call => call.args.join(' ') === `network disconnect none ${worker.containerId}`), fault === 'none');
    assert.equal(installed.length, 5);
    assert.equal(installed.filter(call => call.args.includes('DROP')).length, 4);
    const accept = installed.find(call => call.args.includes('ACCEPT'))!;
    assert.ok(accept.args.includes('172.28.0.1') && accept.args.includes('12345'));
    if (fault === 'disconnect') {
      await assert.rejects(network.close());
      assert.ok(!calls.some(call => call.args.includes('-D')));
    } else {
      await network.close();
      const disconnect = calls.findIndex(call => call.args.includes('--force'));
      const deleteRule = calls.findIndex(call => call.args.includes('-D'));
      assert.ok(disconnect > joinIndex && deleteRule > disconnect);
      assert.equal(calls.filter(call => call.args.includes('-D')).length, 5);
    }
  }
});
