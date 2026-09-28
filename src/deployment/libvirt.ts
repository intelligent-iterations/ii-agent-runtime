import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { libvirtOptions } from './libvirt-options.js';
import { loadLibvirtDeployment, libvirtPhase, withLibvirtLock, type LibvirtManifest } from './libvirt-workspace.js';
import { durableWrite } from './workspace.js';
import { commands, toolEnvironment, type CommandExecutor } from './commands.js';
import type { VMObservation } from './tart.js';

const requiredBlocks = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15'];
const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function options(m: LibvirtManifest) {
  return { cwd: m.directory, env: toolEnvironment(), timeoutMs: libvirtOptions(m.setup).timeouts.commandMs };
}
async function virsh(m: LibvirtManifest, driver: CommandExecutor, ...args: string[]): Promise<string> {
  return driver.run(m.binaries.virsh, ['-c', 'qemu:///system', ...args], options(m));
}
function imageName(image: string): { volume: string; digest: string } {
  const match = /^([A-Za-z0-9_.-]{1,128})@sha256:([a-f0-9]{64})$/.exec(image);
  if (!match) throw Error('libvirt image must be a pinned storage-pool volume name');
  return { volume: match[1]!, digest: match[2]! };
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function volumePath(path: string): string {
  const candidate = path.trim();
  if (!isAbsolute(candidate) || realpathSync(candidate) !== candidate || !lstatSync(candidate).isFile()) {
    throw Error('Unsafe libvirt volume path');
  }
  return candidate;
}
async function inventory(m: LibvirtManifest, driver: CommandExecutor): Promise<{ vm: boolean; filter: boolean; volume: boolean }> {
  const pool = libvirtOptions(m.setup).storagePool;
  const [domains, filters, volumes] = await Promise.all([
    virsh(m, driver, 'list', '--all', '--name'), virsh(m, driver, 'nwfilter-list'),
    virsh(m, driver, 'vol-list', '--pool', pool),
  ]);
  const has = (output: string, name: string) => output.split(/\r?\n/).some(line => line.trim() === name || line.trim().endsWith(` ${name}`));
  return { vm: has(domains, m.vmName), filter: has(filters, m.filterName),
    volume: volumes.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === `${m.vmName}.qcow2`) };
}
function filterXml(m: LibvirtManifest, hostAddresses = Object.values(networkInterfaces()).flatMap(items =>
  (items ?? []).filter(item => item.family === 'IPv4').map(item => item.address))): string {
  const policy = libvirtOptions(m.setup).network;
  const cidrs = new Set([...requiredBlocks, ...policy.blockCidrs]);
  for (const address of hostAddresses) {
    if (isIP(address) !== 4) throw Error('Invalid host address');
    cidrs.add(`${address}/32`);
  }
  const rules = [...cidrs].sort().map(cidr => {
    const [address, mask] = cidr.split('/');
    return `  <rule action='drop' direction='out' priority='-900'><ip dstipaddr='${address}' dstipmask='${mask}'/></rule>`;
  });
  return `<filter name='${m.filterName}' chain='root'>\n  <filterref filter='clean-traffic'/>\n${rules.join('\n')}\n  <rule action='drop' direction='out' priority='-900'><ipv6/></rule>\n</filter>\n`;
}
async function verifyFilter(m: LibvirtManifest, driver: CommandExecutor): Promise<void> {
  const saved = readFileSync(join(m.directory, 'filter.xml'), 'utf8');
  const expected = saved + filterXml(m);
  const actual = await virsh(m, driver, 'nwfilter-dumpxml', m.filterName);
  if (!(actual.includes(`name='${m.filterName}'`) || actual.includes(`name="${m.filterName}"`)) ||
      !/<filterref\s+filter=['"]clean-traffic['"]\s*\/>/.test(actual) ||
      (actual.match(/<filterref\b/g) ?? []).length !== 1 ||
      /<rule\s+action=['"]accept['"]/.test(actual) ||
      !/<rule\s+action=['"]drop['"]\s+direction=['"]out['"]\s+priority=['"]-900['"]>\s*<ipv6\s*\/>/.test(actual)) {
    throw Error('Network filter not confirmed');
  }
  for (const [, address, mask] of expected.matchAll(/dstipaddr='([^']+)' dstipmask='([^']+)'/g)) {
    const rule = new RegExp(`<rule\\s+action=['"]drop['"]\\s+direction=['"]out['"]\\s+priority=['"]-900['"]>\\s*<ip\\s+dstipaddr=['"]${address!.replaceAll('.', '\\.')}['"]\\s+dstipmask=['"]${mask}['"]`);
    if (!rule.test(actual)) throw Error('Network filter is incomplete');
  }
}
function domainXml(m: LibvirtManifest, diskPath: string): string {
  const d = m.setup.deployment;
  const network = libvirtOptions(m.setup).network.name;
  return `<domain type='kvm'>\n  <name>${m.vmName}</name>\n  <memory unit='MiB'>${d.memoryMiB}</memory>\n  <vcpu>${d.cpu}</vcpu>\n  <os firmware='efi'><type arch='x86_64'>hvm</type><boot dev='hd'/></os>\n  <features><acpi/></features>\n  <devices>\n    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='${xmlEscape(diskPath)}'/><target dev='vda' bus='virtio'/></disk>\n    <interface type='network'><source network='${network}'/><model type='virtio'/><filterref filter='${m.filterName}'/></interface>\n    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>\n    <console type='pty'/>\n  </devices>\n</domain>\n`;
}
function update(m: LibvirtManifest, phase: string): void { durableWrite(join(m.directory, 'phase.json'), { phase }); }

export async function inspectLibvirtDeployment(manifestPath: string, driver = commands): Promise<VMObservation> {
  const m = loadLibvirtDeployment(manifestPath);
  const state = await inventory(m, driver);
  if (!state.vm) return { present: false, running: false };
  const xml = await virsh(m, driver, 'dumpxml', m.vmName);
  const diskPath = volumePath(await virsh(m, driver, 'vol-path', '--pool', libvirtOptions(m.setup).storagePool, `${m.vmName}.qcow2`));
  const memory = /<memory\s+unit=['"](KiB|MiB)['"]>(\d+)<\/memory>/.exec(xml);
  const cpu = /<vcpu(?:\s+[^>]*)?>(\d+)<\/vcpu>/.exec(xml);
  const memoryMiB = memory?.[1] === 'KiB' ? Number(memory[2]) / 1024 : Number(memory?.[2]);
  if (!xml.includes(`<name>${m.vmName}</name>`) ||
      !(xml.includes(`filter='${m.filterName}'`) || xml.includes(`filter="${m.filterName}"`)) ||
      !xml.includes(`file='${xmlEscape(diskPath)}'`) && !xml.includes(`file="${xmlEscape(diskPath)}"`) ||
      Number(cpu?.[1]) !== m.setup.deployment.cpu || memoryMiB !== m.setup.deployment.memoryMiB) throw Error('VM ownership changed');
  const running = (await virsh(m, driver, 'domstate', m.vmName)).trim() === 'running';
  return { present: true, running, cpu: Number(cpu![1]), memoryMiB };
}

/** Define the filter before the domain. On any partial failure, only explicit reconciliation may retry. */
export async function createLibvirtVM(manifestPath: string, driver = commands): Promise<VMObservation> {
  return withLibvirtLock(manifestPath, async () => {
    const m = loadLibvirtDeployment(manifestPath);
    if (libvirtPhase(m) !== 'prepared') throw Error('Creation already attempted; reconcile first');
    const current = await inventory(m, driver);
    if (current.vm || current.filter || current.volume) throw Error('Refusing to replace an existing libvirt resource');
    const { volume, digest } = imageName(m.setup.deployment.image);
    const pool = libvirtOptions(m.setup).storagePool;
    const sourcePath = volumePath(await virsh(m, driver, 'vol-path', '--pool', pool, volume));
    const sourceXml = await virsh(m, driver, 'vol-dumpxml', '--pool', pool, volume);
    if (!/<format type=['"]qcow2['"]\s*\/>/.test(sourceXml)) throw Error('Base image must be qcow2');
    if (await fileDigest(sourcePath) !== digest) throw Error('Base image digest mismatch');
    const capacity = /<capacity unit=['"]bytes['"]>(\d+)<\/capacity>/.exec(sourceXml)?.[1];
    if (!capacity || !Number.isSafeInteger(Number(capacity)) || Number(capacity) < 1024 * 1024 * 1024) throw Error('Invalid base image capacity');
    const network = libvirtOptions(m.setup).network.name;
    const netInfo = await virsh(m, driver, 'net-info', network);
    if (!/^Active:\s+yes\s*$/m.test(netInfo)) throw Error('Libvirt network is inactive');
    const netXml = await virsh(m, driver, 'net-dumpxml', network);
    if (!/<forward\s+mode=['"]nat['"]/.test(netXml)) throw Error('Libvirt network must use NAT');
    update(m, 'creating');
    const filterPath = join(m.directory, 'filter.xml');
    writeFileSync(filterPath, filterXml(m), { flag: 'wx', mode: 0o600 });
    await virsh(m, driver, 'nwfilter-define', filterPath);
    await verifyFilter(m, driver);
    await virsh(m, driver, 'vol-create-as', pool, `${m.vmName}.qcow2`, capacity,
      '--format', 'qcow2', '--backing-vol', volume, '--backing-vol-format', 'qcow2');
    const diskPath = volumePath(await virsh(m, driver, 'vol-path', '--pool', pool, `${m.vmName}.qcow2`));
    const xmlPath = join(m.directory, 'domain.xml');
    writeFileSync(xmlPath, domainXml(m, diskPath), { flag: 'wx', mode: 0o600 });
    await virsh(m, driver, 'define', xmlPath);
    const observed = await inspectLibvirtDeployment(manifestPath, driver);
    if (!observed.present || observed.running) throw Error('VM definition not verified');
    update(m, 'configured');
    return observed;
  });
}

export async function startLibvirtVM(manifestPath: string, driver = commands): Promise<void> {
  return withLibvirtLock(manifestPath, async () => {
    const m = loadLibvirtDeployment(manifestPath);
    if (libvirtPhase(m) !== 'configured') throw Error('VM is not ready to start');
    const current = await inspectLibvirtDeployment(manifestPath, driver);
    if (!current.present || current.running) throw Error('VM configuration changed');
    await verifyFilter(m, driver);
    const netXml = await virsh(m, driver, 'net-dumpxml', libvirtOptions(m.setup).network.name);
    if (!/<forward\s+mode=['"]nat['"]/.test(netXml)) throw Error('Libvirt network policy changed');
    update(m, 'starting');
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await virsh(m, driver, 'start', m.vmName); }
      catch {
        // A failed CLI response can still mean the VM started. Inspect the owned
        // domain before another start; a changed definition must fail closed.
      }
      const observed = await inspectLibvirtDeployment(manifestPath, driver);
      if (observed.running) { update(m, 'running'); return; }
      if (attempt === 2) throw Error('VM start not confirmed');
      await verifyFilter(m, driver);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  });
}

export async function removeLibvirtVM(manifestPath: string, driver = commands): Promise<VMObservation> {
  return withLibvirtLock(manifestPath, async () => {
    const m = loadLibvirtDeployment(manifestPath);
    const pool = libvirtOptions(m.setup).storagePool;
    const current = await inventory(m, driver);
    if (current.vm) {
      const observed = await inspectLibvirtDeployment(manifestPath, driver);
      if (observed.running) await virsh(m, driver, 'destroy', m.vmName);
      await virsh(m, driver, 'undefine', m.vmName, '--nvram');
    }
    if (current.volume) await virsh(m, driver, 'vol-delete', '--pool', pool, `${m.vmName}.qcow2`);
    if (current.filter) await virsh(m, driver, 'nwfilter-undefine', m.filterName);
    const after = await inventory(m, driver);
    if (after.vm || after.volume || after.filter) throw Error('Libvirt removal not confirmed');
    update(m, 'removed');
    return { present: false, running: false };
  });
}

async function guestAgent(m: LibvirtManifest, driver: CommandExecutor, request: object, deadline?: number): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(request);
  if (payload.includes("'") || payload.includes('\n')) throw Error('Invalid guest agent request');
  const remaining = deadline === undefined ? libvirtOptions(m.setup).timeouts.guestCommandMs : deadline - Date.now();
  if (remaining < 1) throw Error('Guest command timed out');
  // The request may contain credentials. Feed virsh through stdin so they never appear in argv.
  const output = await driver.run(m.binaries.virsh, ['-q', '-c', 'qemu:///system'], {
    ...options(m), timeoutMs: Math.min(libvirtOptions(m.setup).timeouts.guestCommandMs, remaining),
    input: `qemu-agent-command ${m.vmName} '${payload}'\nquit\n`,
  });
  const response = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'));
  if (response.length !== 1) throw Error('Invalid guest agent response');
  const parsed: unknown = JSON.parse(response[0]!);
  if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'return') || Object.hasOwn(parsed, 'error')) {
    throw Error('Guest agent command failed');
  }
  return parsed as Record<string, unknown>;
}

/** Executes a prepared command through QEMU Guest Agent without SSH or shared host paths. */
export async function executeLibvirtGuest(
  manifestPath: string, command: string[], input?: string | Uint8Array, driver = commands,
): Promise<string> {
  const m = loadLibvirtDeployment(manifestPath);
  if (!command.length || !command[0] || command[0].startsWith('-') || command.some(value => value.includes('\0')) ||
      (input !== undefined && Buffer.byteLength(input) > 128 * 1024 * 1024)) throw Error('Invalid guest command');
  if (!(await inspectLibvirtDeployment(manifestPath, driver)).running) throw Error('VM is not running');
  const deadline = Date.now() + libvirtOptions(m.setup).timeouts.guestCommandMs;
  const encoded = Buffer.from(JSON.stringify(command)).toString('base64');
  const bytes = input === undefined ? undefined : Buffer.from(input);
  let file: string | undefined;
  if (bytes && bytes.length > 256 * 1024) {
    // Large consumer inputs are chunked through the guest agent. /root is not readable by the workload user.
    file = `/root/runtime-input-${randomUUID()}`;
    const opened = (await guestAgent(m, driver, { execute: 'guest-file-open', arguments: { path: file, mode: 'w' } }, deadline)).return;
    if (!Number.isSafeInteger(opened) || Number(opened) < 0) throw Error('Invalid guest file handle');
    const handle = Number(opened);
    try {
      for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
        const chunk = bytes.subarray(offset, offset + 128 * 1024);
        const written = (await guestAgent(m, driver, { execute: 'guest-file-write', arguments: {
          handle, 'buf-b64': chunk.toString('base64'), count: chunk.length,
        } }, deadline)).return as { count?: unknown };
        if (written?.count !== chunk.length) throw Error('Guest input transfer incomplete');
      }
    } finally { await guestAgent(m, driver, { execute: 'guest-file-close', arguments: { handle } }, deadline); }
  }
  const python = file
    ? `import base64,json,os;a=json.loads(base64.b64decode("${encoded}"));p="${file}";fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);os.unlink(p);os.dup2(fd,0);os.execvp(a[0],a)`
    : `import base64,json,os;a=json.loads(base64.b64decode("${encoded}"));os.execvp(a[0],a)`;
  const request = { execute: 'guest-exec', arguments: { path: '/usr/bin/python3', arg: ['-c', python],
    'capture-output': true, ...(!bytes || file ? {} : { 'input-data': bytes.toString('base64') }) } };
  const initial = (await guestAgent(m, driver, request, deadline)).return as { pid?: unknown };
  if (!Number.isSafeInteger(initial?.pid) || Number(initial.pid) < 1) throw Error('Invalid guest process identity');
  while (Date.now() < deadline) {
    const status = (await guestAgent(m, driver, { execute: 'guest-exec-status', arguments: { pid: initial.pid } }, deadline)).return as
      { exited?: unknown; exitcode?: unknown; 'out-data'?: unknown; 'out-truncated'?: unknown; 'err-truncated'?: unknown };
    if (status?.exited === true) {
      if (status.exitcode !== 0 || status['out-truncated'] === true || status['err-truncated'] === true ||
          (status['out-data'] !== undefined && typeof status['out-data'] !== 'string')) throw Error('Guest command failed');
      const output = Buffer.from((status['out-data'] as string | undefined) ?? '', 'base64');
      if (output.length > 512 * 1024) throw Error('Guest output too large');
      return output.toString('utf8');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Guest command timed out');
}

export async function libvirtAddress(manifestPath: string, driver = commands): Promise<string> {
  const m = loadLibvirtDeployment(manifestPath);
  if (!(await inspectLibvirtDeployment(manifestPath, driver)).running) throw Error('VM is not running');
  const result = (await guestAgent(m, driver, { execute: 'guest-network-get-interfaces' })).return;
  if (!Array.isArray(result)) throw Error('Invalid guest network inventory');
  const addresses = result.flatMap((item: unknown) => {
    const value = item as { 'ip-addresses'?: { 'ip-address'?: string; 'ip-address-type'?: string }[] };
    return value['ip-addresses'] ?? [];
  }).filter(address => address['ip-address-type'] === 'ipv4' && isIP(address['ip-address'] ?? '') === 4 &&
    !address['ip-address']!.startsWith('127.'));
  if (addresses.length !== 1) throw Error('Guest address unavailable or ambiguous');
  return addresses[0]!['ip-address']!;
}

export const libvirtNetworkFilterXml = filterXml;
export const libvirtDomainXml = domainXml;
