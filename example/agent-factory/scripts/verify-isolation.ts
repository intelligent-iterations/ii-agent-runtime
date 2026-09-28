import { factoryTartOptions } from '../src/defaults.js';
/** Live credential-free IPv4 TCP isolation probe using only owned listeners and runtime VMs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';
import { prepareTartDeployment, deployTart, startTartVM, executeTartGuest, destroyTart, inspectTartDeployment } from '@intelligent-iterations/ii-agent-runtime';
const [image, directory] = process.argv.slice(2);
if (!image || !directory) throw Error('Usage: verify-isolation.ts pinned-image new-directory');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address)))];
assert.ok(addresses.length, 'Need at least one host interface to test');
let hostConnections = 0;
const listener = createServer(socket => { hostConnections++; socket.on('error', () => {}); socket.end('owned-isolation-probe'); });
await new Promise<void>((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '0.0.0.0', resolveListen); });
const address = listener.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
const manifests: string[] = [];
const probe = `import json,socket,subprocess,sys
r=[]
for target in json.loads(sys.argv[1]):
 s=socket.socket();s.settimeout(3)
 try:
  s.connect((target['host'],target['port']));connected=True
 except OSError: connected=False
 finally: s.close()
 r.append(dict(target,connected=connected))
p=subprocess.run(['curl','--silent','--show-error','--max-time','15','--output','/dev/null','--write-out','%{http_code}','https://api.github.com'],capture_output=True,text=True,timeout=20)
print(json.dumps({'targets':r,'github':{'exitCode':p.returncode,'httpCode':p.stdout}}))`;
try {
  for (const host of addresses) await new Promise<void>((resolveConnect, reject) => {
    const socket = connect({ host, port }); socket.setTimeout(3000);
    socket.once('connect', () => { socket.end(); resolveConnect(); }); socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(Error('Host listener control failed')); });
  });
  const guests: Array<{ path: string; ip: string; gateway: string; mac: string; port: number }> = [];
  for (let index = 0; index < 2; index++) {
    const deploymentRoot = join(root, `guest-${index}`); mkdirSync(deploymentRoot, { mode: 0o700 });
    const manifest = prepareTartDeployment(deploymentRoot, { schemaVersion: 1, id: 'isolation-proof', revision: '1', harness: { name: 'diagnostic', version: '1' },
      deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } },
      { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') });
    const path = join(manifest.directory, 'manifest.json'); manifests.push(path);
    await deployTart(path, { subject: 'isolation-proof', authorize: async () => ({ status: 'verified', evidenceId: 'owned-credential-free-listeners' }), inspectSecret: async () => { throw Error('No secrets'); } });
    await startTartVM(path); console.log(`Guest ${index} started`);
    const deadline = Date.now() + 90_000;
    while (true) { try { await executeTartGuest(path, ['true']); break; } catch { if (Date.now() >= deadline) throw Error('Guest not ready'); await new Promise(r => setTimeout(r, 1000)); } }
    const identity = JSON.parse(await executeTartGuest(path, ['python3', '-c', "import json,subprocess;r=json.loads(subprocess.check_output(['ip','-j','route','get','1.1.1.1']))[0];link=json.loads(subprocess.check_output(['ip','-j','link','show','dev',r['dev']]))[0];print(json.dumps({'ip':r['prefsrc'],'gateway':r['gateway'],'mac':link['address']}))"]));
    const guestPort = 18347 + index;
    const serve = `import socket;s=socket.socket();s.bind(('0.0.0.0',${guestPort}));s.listen()\nwhile True:\n c,a=s.accept();c.sendall(b'owned-guest-listener');c.close()`;
    await executeTartGuest(path, ['python3', '-c', 'import subprocess,sys;subprocess.Popen([sys.executable,"-c",sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)', serve]);
    // Positive control through the guest's own interface, not only loopback.
    await executeTartGuest(path, ['python3', '-c', 'import socket,sys,time;time.sleep(.2);s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3);assert s.recv(100)==b"owned-guest-listener";s.close()', identity.ip, String(guestPort)]);
    guests.push({ path, ...identity, port: guestPort });
  }
  write('guests.json', guests);
  assert.notEqual(guests[0]!.mac, guests[1]!.mac, 'Cloned guests must have distinct MAC addresses');
  assert.notEqual(guests[0]!.ip, guests[1]!.ip, 'Cloned guests must have distinct IPv4 addresses');
  const controls = hostConnections;
  const results = [];
  for (let index = 0; index < guests.length; index++) {
    const guest = guests[index]!; const peer = guests[1 - index]!;
    const targets = [{ kind: 'peer', host: peer.ip, port: peer.port }, ...[...new Set([...addresses, guest.gateway])].map(host => ({ kind: 'host', host, port }))];
    const result = JSON.parse(await executeTartGuest(guest.path, ['python3', '-c', probe, JSON.stringify(targets)]));
    results.push({ guest: index, ...result }); write(`probe-${index}.json`, results[index]);
    console.log(JSON.stringify(results[index]));
    assert.ok(result.targets.every((target: { connected: boolean }) => !target.connected), 'Guest reached an isolated listener');
    assert.equal(result.github.exitCode, 0, 'Public connectivity control failed'); assert.equal(result.github.httpCode, '200');
  }
  assert.equal(hostConnections, controls, 'Host accepted an unexpected guest connection');
  write('proof.json', { image, guests, hostAddresses: addresses, hostPort: port, hostPositiveControls: controls, results,
    scope: 'IPv4 TCP on owned listening ports; not exhaustive IPv6, UDP or public-address isolation' });
} finally {
  await new Promise<void>(resolveClose => listener.close(() => resolveClose()));
  const cleanup = await Promise.allSettled(manifests.map(async path => { await destroyTart(path); assert.equal((await inspectTartDeployment(path)).present, false); return { path, independentlyAbsent: true }; }));
  write('cleanup.json', cleanup.map(result => result.status === 'fulfilled' ? result.value : { failed: true }));
  assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'VM cleanup requires reconciliation');
  console.log('Both owned VMs independently absent; host listener closed');
}
