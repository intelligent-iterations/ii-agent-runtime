import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, setupDigest, type Setup } from '../src/setup.js';
import { libvirtOptions } from '../src/deployment/libvirt-options.js';
import { loadLibvirtDeployment, recoverLibvirtLock, type LibvirtManifest } from '../src/deployment/libvirt-workspace.js';
import { createLibvirtVM, startLibvirtVM, inspectLibvirtDeployment, executeLibvirtGuest, removeLibvirtVM, libvirtNetworkFilterXml } from '../src/deployment/libvirt.js';
import type { CommandExecutor } from '../src/deployment/commands.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-libvirt-')));
  const id = randomUUID(); const directory = join(root, id); mkdirSync(directory); mkdirSync(join(directory, 'tofu'));
  const base = join(root, 'base.qcow2'); writeFileSync(base, 'base');
  const image = `base.qcow2@sha256:${createHash('sha256').update('base').digest('hex')}`;
  const setup = { schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'test', version: '1' },
    deployment: { provider: 'libvirt', image, cpu: 2, memoryMiB: 2048,
      options: { storagePool: 'ii-factory', network: { name: 'ii-factory', blockCidrs: [], blockHostAddresses: true },
        timeouts: { commandMs: 1000, guestCommandMs: 1000, tofuMs: 1000, tofuLockMs: 1000 } } },
    secrets: [], capture: { paths: [] } } as Setup;
  const m: LibvirtManifest = { schemaVersion: 1, operationId: id, directory, vmName: `runtime-${id}`,
    filterName: `runtime-${id}`, setup, digest: setupDigest(setup),
    binaries: { virsh: '/usr/bin/virsh', tofu: '/usr/bin/tofu', node: '/usr/bin/node' } };
  const path = join(directory, 'manifest.json');
  writeFileSync(path, canonicalJson(m)); writeFileSync(join(directory, 'phase.json'), '{"phase":"prepared"}');
  const overlay = join(root, `${m.vmName}.qcow2`);
  const state = { vm: false, filter: false, volume: false, running: false, failDefine: false,
    failStarts: 0, lostStartResponse: false, xml: '' };
  const calls: string[] = [];
  const driver: CommandExecutor = { start: async () => { throw Error('Unexpected detached process'); },
    run: async (_binary, args) => {
      const command = args.slice(2); calls.push(command.join(' '));
      switch (command[0]) {
        case 'list': return state.vm ? m.vmName + '\n' : '';
        case 'nwfilter-list': return state.filter ? m.filterName + '\n' : '';
        case 'vol-list': return state.volume ? `${m.vmName}.qcow2\n` : '';
        case 'vol-path': return command.at(-1) === 'base.qcow2' ? base + '\n' : overlay + '\n';
        case 'vol-dumpxml': return "<volume><capacity unit='bytes'>2147483648</capacity><target><format type='qcow2'/></target></volume>";
        case 'net-info': return 'Active: yes\n';
        case 'net-dumpxml': return "<network><forward mode='nat'/></network>";
        case 'nwfilter-define': state.filter = true; return '';
        case 'nwfilter-dumpxml': return readFileSync(join(directory, 'filter.xml'), 'utf8');
        case 'vol-create-as': state.volume = true; writeFileSync(overlay, 'overlay'); return '';
        case 'define': if (state.failDefine) throw Error('Simulated lost define response');
          state.vm = true; state.xml = readFileSync(join(directory, 'domain.xml'), 'utf8'); return '';
        case 'dumpxml': return state.xml;
        case 'domstate': return state.running ? 'running\n' : 'shut off\n';
        case 'start':
          if (state.failStarts-- > 0) throw Error('Transient libvirt start failure');
          state.running = true;
          if (state.lostStartResponse) throw Error('Lost start response');
          return '';
        case 'destroy': state.running = false; return '';
        case 'undefine': state.vm = false; return '';
        case 'vol-delete': state.volume = false; rmSync(overlay); return '';
        case 'nwfilter-undefine': state.filter = false; return '';
        default: throw Error(`Unexpected command ${command[0]}`);
      }
    } };
  return { m, path, state, calls, driver, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('Linux policy is explicit, blocks host/private IPv4 and all IPv6', () => {
  const f = fixture();
  try {
    assert.equal(libvirtOptions(f.m.setup).storagePool, 'ii-factory');
    const xml = libvirtNetworkFilterXml(f.m, ['203.0.113.20']);
    for (const address of ['10.0.0.0', '172.16.0.0', '192.168.0.0', '203.0.113.20']) assert.match(xml, new RegExp(address.replaceAll('.', '\\.')));
    assert.match(xml, /priority='-900'><ipv6\/>/); assert.match(xml, /clean-traffic/);
    assert.doesNotMatch(xml, /priority='100'/);
    const changed = structuredClone(f.m.setup); (changed.deployment.options as object) = { network: { name: 'ii-factory' } };
    assert.throws(() => libvirtOptions(changed));
  } finally { f.close(); }
});

test('libvirt creation installs filter before defining VM and removes only owned resources', async () => {
  const f = fixture();
  try {
    assert.equal(loadLibvirtDeployment(f.path).vmName, f.m.vmName);
    assert.equal((await createLibvirtVM(f.path, f.driver)).present, true);
    assert.ok(f.calls.findIndex(call => call.startsWith('nwfilter-define')) < f.calls.findIndex(call => call.startsWith('define')));
    await startLibvirtVM(f.path, f.driver);
    assert.equal((await inspectLibvirtDeployment(f.path, f.driver)).running, true);
    await removeLibvirtVM(f.path, f.driver);
    assert.deepEqual({ vm: f.state.vm, filter: f.state.filter, volume: f.state.volume }, { vm: false, filter: false, volume: false });
    assert.equal((await removeLibvirtVM(f.path, f.driver)).present, false);
  } finally { f.close(); }
});

test('partial creation cannot launch or retry and is explicitly recoverable', async () => {
  const f = fixture();
  try {
    f.state.failDefine = true;
    await assert.rejects(createLibvirtVM(f.path, f.driver));
    await assert.rejects(startLibvirtVM(f.path, f.driver));
    await assert.rejects(createLibvirtVM(f.path, f.driver), /reconcile/);
    recoverLibvirtLock(f.path);
    await removeLibvirtVM(f.path, f.driver);
    assert.equal(f.state.filter, false); assert.equal(f.state.volume, false);
  } finally { f.close(); }
});

test('start reconciles a transient CLI failure or lost response against the owned domain', async () => {
  for (const lostStartResponse of [false, true]) {
    const f = fixture();
    try {
      await createLibvirtVM(f.path, f.driver);
      f.state.failStarts = lostStartResponse ? 0 : 1;
      f.state.lostStartResponse = lostStartResponse;
      await startLibvirtVM(f.path, f.driver);
      assert.equal(f.state.running, true);
      assert.equal(f.calls.filter(call => call.startsWith('start ')).length, lostStartResponse ? 1 : 2);
      assert.equal(JSON.parse(readFileSync(join(f.m.directory, 'phase.json'), 'utf8')).phase, 'running');
      await removeLibvirtVM(f.path, f.driver);
    } finally { f.close(); }
  }
});

test('repeated start failure stays unconfirmed and remains explicitly removable', async () => {
  const f = fixture();
  try {
    await createLibvirtVM(f.path, f.driver);
    f.state.failStarts = 3;
    await assert.rejects(startLibvirtVM(f.path, f.driver), /not confirmed/);
    assert.equal(JSON.parse(readFileSync(join(f.m.directory, 'phase.json'), 'utf8')).phase, 'starting');
    await removeLibvirtVM(f.path, f.driver);
    assert.equal(f.state.vm, false);
  } finally { f.close(); }
});

test('guest command credentials travel on stdin and large inputs are chunked with verified writes', async () => {
  const f = fixture();
  try {
    await createLibvirtVM(f.path, f.driver); await startLibvirtVM(f.path, f.driver);
    const transferred: Buffer[] = [];
    const requests: { execute: string; arguments?: Record<string, unknown> }[] = [];
    const driver: CommandExecutor = { start: f.driver.start, run: async (binary, args, options) => {
      if (args[0] !== '-q') return f.driver.run(binary, args, options);
      assert.deepEqual(args, ['-q', '-c', 'qemu:///system']);
      const line = String(options.input).split('\n')[0]!;
      const match = /^qemu-agent-command runtime-[a-f0-9-]+ '(.+)'$/.exec(line);
      assert.ok(match);
      const request = JSON.parse(match[1]!) as { execute: string; arguments?: Record<string, unknown> };
      requests.push(request);
      if (request.execute === 'guest-file-open') return '{"return":7}\n';
      if (request.execute === 'guest-file-write') {
        transferred.push(Buffer.from(String(request.arguments?.['buf-b64']), 'base64'));
        return JSON.stringify({ return: { count: request.arguments?.count } }) + '\n';
      }
      if (request.execute === 'guest-file-close') return '{"return":{}}\n';
      if (request.execute === 'guest-exec') return '{"return":{"pid":42}}\n';
      if (request.execute === 'guest-exec-status') return '{"return":{"exited":true,"exitcode":0,"out-data":"b2s="}}\n';
      throw Error('Unexpected guest agent request');
    } };
    const secret = 'credential-never-in-argv';
    assert.equal(await executeLibvirtGuest(f.path, ['python3', '-c', 'print(1)'], secret, driver), 'ok');
    assert.ok(!JSON.stringify(f.calls).includes(secret));
    assert.equal(Buffer.from(String(requests.find(request => request.execute === 'guest-exec')?.arguments?.['input-data']), 'base64').toString(), secret);
    requests.length = 0;
    const large = 'x'.repeat(300_000);
    assert.equal(await executeLibvirtGuest(f.path, ['python3', '-c', 'print(1)'], large, driver), 'ok');
    assert.equal(Buffer.concat(transferred).toString(), large);
    assert.deepEqual(requests.slice(0, 2).map(request => request.execute), ['guest-file-open', 'guest-file-write']);
    assert.equal(requests.find(request => request.execute === 'guest-exec')?.arguments?.['input-data'], undefined);
  } finally { f.close(); }
});
