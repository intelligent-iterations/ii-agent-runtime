import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retainWorkerNetwork, reconcileWorkerNetworks } from '../../../../src/providers/execution/docker/ancillaries.js';

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'retained-network-'))), marker = randomUUID();
  writeFileSync(join(directory, '.owner'), marker, { mode: 0o600 });
  t.after(() => { assert.equal(readFileSync(join(directory, '.owner'), 'utf8'), marker); rmSync(directory, { recursive: true }); });
  return { directory, owner: 'a'.repeat(32) };
}

test('fresh cleanup removes only journal-bound firewall rules and leaves unrelated rules intact', async t => {
  const { directory, owner } = fixture(t), bridge = 'br-' + 'b'.repeat(12);
  retainWorkerNetwork(directory, { owner, purpose: 'isolation', bridge, networkId: 'b'.repeat(64) });
  const calls: string[][] = []; let present = true;
  const foreign = `-A INPUT -i other0 -m comment --comment another-owner -j DROP`;
  await reconcileWorkerNetworks({ directory, owner, run: async (_command, args) => {
    calls.push(args);
    const chain = args[args.indexOf('-S') + 1];
    if (args.includes('-S') && args.includes('iptables') && chain === 'INPUT') return foreign + '\n' +
      (present ? `-A INPUT -i ${bridge} -m comment --comment "agent-runtime:${owner}" -j DROP` : '');
    if (args.includes('-D')) {
      assert.ok(args.includes(bridge)); assert.ok(args.includes(`agent-runtime:${owner}`)); assert.ok(!args.includes('another-owner'));
      present = false;
    }
    return '';
  } });
  assert.equal(calls.filter(args => args.includes('-D')).length, 1);
  assert.equal(present, false);
});

test('changed network journal is preserved before any host operation', async t => {
  const { directory, owner } = fixture(t); let calls = 0;
  retainWorkerNetwork(directory, { owner, purpose: 'setup', bridge: 'afs-' + owner.slice(0, 11) });
  writeFileSync(join(directory, 'network-setup.json'), JSON.stringify({ owner: 'another', purpose: 'setup', bridge: 'other' }));
  await assert.rejects(reconcileWorkerNetworks({ directory, owner, run: async () => { calls++; return ''; } }), /ownership changed/);
  assert.equal(calls, 0);
});

test('an unowned setup network is never removed', async t => {
  const { directory, owner } = fixture(t); const calls: string[][] = [];
  retainWorkerNetwork(directory, { owner, purpose: 'setup', bridge: 'afs-' + owner.slice(0, 11) });
  await assert.rejects(reconcileWorkerNetworks({ directory, owner, run: async (_command, args) => {
    calls.push(args);
    if (args[1] === 'ls') return 'b'.repeat(64);
    return JSON.stringify([{ Id: 'b'.repeat(64), Name: 'agent-runtime-setup-' + owner,
      Labels: { 'agent-runtime.owner': 'another' }, Containers: {} }]);
  } }), /ownership changed/);
  assert.equal(calls.some(args => args.includes('rm')), false);
});
