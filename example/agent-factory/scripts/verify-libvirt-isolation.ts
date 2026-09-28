import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { prepareLibvirtDeployment, deployLibvirt, startLibvirtVM, executeLibvirtGuest,
  libvirtAddress, destroyLibvirt, removeLibvirtVM } from '@intelligent-iterations/ii-agent-runtime';
import { factoryLibvirtOptions } from '../src/defaults.js';

if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Run this check on a Linux x64 KVM host');
const image = process.argv[2];
if (!image) throw Error('Usage: npm run verify:linux -- VOLUME@sha256:DIGEST');
const hostAddress = Object.values(networkInterfaces()).flatMap(items => items ?? [])
  .find(item => item.family === 'IPv4' && !item.internal)?.address;
if (!hostAddress) throw Error('Host needs a non-loopback IPv4 address');
const binary = (name: string) => realpathSync(execFileSync('which', [name], { encoding: 'utf8' }).trim());
const networkXml = execFileSync(binary('virsh'), ['-c', 'qemu:///system', 'net-dumpxml', 'ii-factory'], { encoding: 'utf8' });
const bridge = /<bridge\s+name=['"]([^'"]+)['"]/.exec(networkXml)?.[1];
if (!bridge) throw Error('Factory network bridge is unavailable');
const hostIpv6 = networkInterfaces()[bridge]?.find(item => item.family === 'IPv6' && item.address.startsWith('fe80:'))?.address ??
  /inet6 (fe80:[0-9a-f:]+)\//.exec(execFileSync(binary('ip'), ['-6', 'addr', 'show', 'dev', bridge], { encoding: 'utf8' }))?.[1];
if (!hostIpv6) throw Error('Host bridge IPv6 link-local address is unavailable for isolation proof');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-linux-isolation-')));
const manifests: string[] = [];
const tcp = createServer(socket => socket.end('ok'));
const udp = createSocket('udp4');
udp.on('message', (message, remote) => udp.send(message, remote.port, remote.address));
const tcp6 = createServer(socket => socket.end('ok'));
const udp6 = createSocket('udp6');
udp6.on('message', (message, remote) => udp6.send(message, remote.port,
  remote.address.includes('%') ? remote.address : `${remote.address}%${bridge}`));
const listen = async () => {
  await new Promise<void>((resolve, reject) => tcp.once('error', reject).listen(0, hostAddress, resolve));
  const port = (tcp.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => udp.once('error', reject).bind(port, hostAddress, resolve));
  await new Promise<void>((resolve, reject) => tcp6.once('error', reject).listen(port, `${hostIpv6}%${bridge}`, resolve));
  await new Promise<void>((resolve, reject) => udp6.once('error', reject).bind(port, `${hostIpv6}%${bridge}`, resolve));
  return port;
};
const server = `import socket,select
p=45793
t=socket.socket();t.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);t.bind(("0.0.0.0",p));t.listen(8)
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.bind(("0.0.0.0",p))
v=socket.socket(socket.AF_INET6,socket.SOCK_STREAM);v.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1);v.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);v.bind(("::",p));v.listen(8)
w=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);w.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1);w.bind(("::",p))
while True:
 ready,_,_=select.select([t,u,v,w],[],[])
 if t in ready:
  c,_=t.accept();c.sendall(b"ok");c.close()
 if u in ready:
  b,a=u.recvfrom(1024);u.sendto(b,a)
 if v in ready:
  c,_=v.accept();c.sendall(b"ok");c.close()
 if w in ready:
  b,a=w.recvfrom(1024);w.sendto(b,a)
`;
const launchServer = `import subprocess,sys
p=subprocess.Popen(["python3","-c",sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print(p.pid)
`;
const probe = `import json,socket,sys
host=sys.argv[1];port=int(sys.argv[2]);result={"tcp":False,"udp":False}
try:
 s=socket.create_connection((host,port),timeout=2);s.settimeout(2);result["tcp"]=s.recv(2)==b"ok";s.close()
except (OSError,TimeoutError): pass
try:
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2);s.sendto(b"ok",(host,port));result["udp"]=s.recvfrom(2)[0]==b"ok";s.close()
except (OSError,TimeoutError): pass
print(json.dumps(result))
`;
const ipv6Address = `import ipaddress,json
for line in open("/proc/net/if_inet6"):
 value,index,prefix,scope,flags,name=line.split()
 if scope=="20" and name!="lo":
  print(json.dumps({"address":str(ipaddress.IPv6Address(int(value,16))),"interface":name}));break
`;
const ipv6Probe = `import json,socket,sys
host=sys.argv[1];port=int(sys.argv[2]);dev=sys.argv[3];scope=0 if host=="::1" else socket.if_nametoindex(dev)
result={"tcp":False,"udp":False}
try:
 s=socket.socket(socket.AF_INET6,socket.SOCK_STREAM);s.settimeout(2);s.connect((host,port,0,scope));result["tcp"]=s.recv(2)==b"ok";s.close()
except (OSError,TimeoutError): pass
try:
 s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);s.settimeout(2);s.sendto(b"ok",(host,port,0,scope));result["udp"]=s.recvfrom(2)[0]==b"ok";s.close()
except (OSError,TimeoutError): pass
print(json.dumps(result))
`;
const context = { subject: 'linux-isolation-probe', authorize: async () => ({ status: 'verified' as const, evidenceId: 'operator-test' }),
  inspectSecret: async () => { throw Error('Probe has no secrets'); } };
let passed = false;
try {
  const hostPort = await listen();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: `${hostIpv6}%${bridge}`, port: hostPort });
    socket.setTimeout(2000, () => socket.destroy(Error('Host IPv6 TCP echo timed out')));
    socket.once('error', reject);
    socket.once('data', data => { if (data.toString() !== 'ok') reject(Error('Host IPv6 TCP echo failed')); else resolve(); socket.destroy(); });
  });
  const hostUdp6 = createSocket('udp6');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Host IPv6 UDP echo failed')), 2000);
      hostUdp6.once('error', reject);
      hostUdp6.once('message', data => { clearTimeout(timer); if (data.toString() === 'ok') resolve(); else reject(Error('Host IPv6 UDP echo changed')); });
      hostUdp6.send(Buffer.from('ok'), hostPort, `${hostIpv6}%${bridge}`);
    });
  } finally { hostUdp6.close(); }
  for (let index = 0; index < 2; index++) {
    const manifest = prepareLibvirtDeployment(root, { schemaVersion: 1, id: `isolation-${index}`, revision: '1',
      harness: { name: 'verification', version: '1' },
      deployment: { provider: 'libvirt', options: factoryLibvirtOptions(), image, cpu: 2, memoryMiB: 2048 },
      secrets: [], capture: { paths: [] } },
    { virsh: binary('virsh'), tofu: binary('tofu'), node: process.execPath });
    manifests.push(join(manifest.directory, 'manifest.json'));
  }
  await Promise.all(manifests.map(path => deployLibvirt(path, context)));
  await Promise.all(manifests.map(path => startLibvirtVM(path)));
  const ready = async (path: string) => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        await executeLibvirtGuest(path, ['python3', '-c',
          'import urllib.request;urllib.request.urlopen("https://api.github.com",timeout=5).close()']);
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    throw Error('Guest never reached public HTTPS');
  };
  await Promise.all(manifests.map(ready));
  const addresses = await Promise.all(manifests.map(path => libvirtAddress(path)));
  const ipv6 = await Promise.all(manifests.map(async path => JSON.parse(await executeLibvirtGuest(path,
    ['python3', '-c', ipv6Address])) as { address: string; interface: string }));
  assert.notEqual(addresses[0], addresses[1], 'VMs share an IP address');
  assert.notEqual(ipv6[0]?.address, ipv6[1]?.address, 'VMs share an IPv6 address');
  const domains = manifests.map(path => JSON.parse(readFileSync(path, 'utf8')).vmName as string);
  const xml = domains.map(name => execFileSync(binary('virsh'), ['-c', 'qemu:///system', 'dumpxml', name], { encoding: 'utf8' }));
  const mac = xml.map(value => /<mac address=['"]([^'"]+)['"]/.exec(value)?.[1]);
  const disk = xml.map(value => /<source file=['"]([^'"]+\.qcow2)['"]/.exec(value)?.[1]);
  assert.ok(mac.every(Boolean) && disk.every(Boolean));
  assert.notEqual(mac[0], mac[1], 'VMs share a MAC address');
  assert.notEqual(disk[0], disk[1], 'VMs share a disk overlay');
  await Promise.all(manifests.map(path => executeLibvirtGuest(path, ['python3', '-c', launchServer, server])));
  for (const path of manifests) {
    const deadline = Date.now() + 10_000;
    while (true) {
      const own = JSON.parse(await executeLibvirtGuest(path, ['python3', '-c', probe, '127.0.0.1', '45793'])) as
        { tcp: boolean; udp: boolean };
      if (own.tcp && own.udp) break;
      if (Date.now() >= deadline) throw Error('Guest echo server did not start');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  for (let index = 0; index < manifests.length; index++) {
    const path = manifests[index]!;
    const check = async (address: string, port: number) => JSON.parse(await executeLibvirtGuest(path,
      ['python3', '-c', probe, address, String(port)])) as { tcp: boolean; udp: boolean };
    assert.deepEqual(await check('127.0.0.1', 45793), { tcp: true, udp: true }, 'Own listener unavailable');
    assert.deepEqual(await check(hostAddress, hostPort), { tcp: false, udp: false }, 'Host listener reached');
    assert.deepEqual(await check(addresses[1 - index]!, 45793), { tcp: false, udp: false }, 'Sibling listener reached');
    const check6 = async (address: string, port = 45793) => JSON.parse(await executeLibvirtGuest(path,
      ['python3', '-c', ipv6Probe, address, String(port), ipv6[index]!.interface])) as { tcp: boolean; udp: boolean };
    assert.deepEqual(await check6('::1'), { tcp: true, udp: true }, 'Own IPv6 listener unavailable');
    assert.deepEqual(await check6(hostIpv6, hostPort), { tcp: false, udp: false }, 'Host IPv6 listener reached');
    assert.deepEqual(await check6(ipv6[1 - index]!.address), { tcp: false, udp: false }, 'Sibling IPv6 listener reached');
  }
  passed = true;
  process.stdout.write(JSON.stringify({ passed: true, vms: domains, ips: addresses, macs: mac, disks: disk }) + '\n');
} finally {
  tcp.close(); udp.close(); tcp6.close(); udp6.close();
  const outcomes = await Promise.allSettled(manifests.map(async path => {
    try { await destroyLibvirt(path); }
    catch (error) { await removeLibvirtVM(path); throw error; }
  }));
  if (outcomes.some(outcome => outcome.status === 'rejected')) {
    process.stderr.write(`Cleanup unconfirmed; retained state: ${root}\n`);
    process.exitCode = 1;
  } else {
    rmSync(root, { recursive: true, force: true });
  }
  if (!passed) process.exitCode = 1;
}
