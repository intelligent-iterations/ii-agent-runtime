import type { RemoteSession } from '../../../src/providers/execution/remote/channel.js';
/** Real SSH + Docker execution conformance. This is a local compute substitute, not a cloud API emulator. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sshSession } from '../../../src/providers/execution/remote/ssh.js';
import { proveNetwork, proveCredentialSeparation } from '../conformance.js';
import { connectRemoteWorker } from '../../../src/providers/execution/remote/worker.js';
import { runTrustedProcess } from '../../../src/providers/shared/process.js';

const root = mkdtempSync(join(homedir(), '.cache/ii-remote-live-'));
const owner = randomBytes(16).toString('hex');
const name = `ii-ssh-test-${owner}`;
const cacheConsumer = `ii-image-consumer-${owner}`;
const workerImage = 'node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c';
const port = Number(process.env.II_TEST_SSH_PORT ?? 22326);
const isolation = process.env.II_TEST_ISOLATION ?? 'docker';
assert.ok(isolation === 'docker' || isolation === 'openshell');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const executor = JSON.parse(docker('image', 'inspect', 'ii-runtime-executor:20261026', '--format', '{{json .RepoDigests}}'))[0] as string;
let session: RemoteSession | undefined;
let created = false;
let consumerCreated = false;
let hits = 0;
const gateway = createServer((_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n'); setTimeout(() => res.end('data: last\n\n'), 50); });
try {
  // A separate container pins the shared image so cleanup must not try to remove it.
  docker('create', '--name', cacheConsumer, '--network', 'none', workerImage, 'sleep', '60');
  consumerCreated = true;
  for (const key of ['client', 'host']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, key)]);
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${readFileSync(join(root, 'host.pub'), 'utf8')}`);
  writeFileSync(join(root, 'sshd_config'), `Port ${port}\nListenAddress 0.0.0.0\nHostKey /test-ssh/host\nAuthorizedKeysFile /test-ssh/client.pub\nStrictModes no\nPasswordAuthentication no\nPermitRootLogin prohibit-password\nAllowTcpForwarding yes\nGatewayPorts clientspecified\nUsePAM no\nPidFile /tmp/ii-sshd.pid\n`);
  writeFileSync(join(root, 'Dockerfile'), `FROM docker:29.2.1-cli\nRUN apk add --no-cache openssh-server sudo && mkdir -p /run/sshd && passwd -d root\nENTRYPOINT ["/usr/sbin/sshd"]\n`);
  docker('build', '-q', '-t', 'ii-runtime-ssh-test:20261026', root);
  docker('run', '-d', '--name', name, '--network', 'host', '--mount', `type=bind,source=${root},target=/test-ssh,readonly`,
    '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', '-v', '/var/lib/ii-runtime:/var/lib/ii-runtime', 'ii-runtime-ssh-test:20261026', '-D', '-e', '-f', '/test-ssh/sshd_config');
  created = true;
  for (let attempt = 0; ; attempt++) {
    try { execFileSync('ssh', ['-F', '/dev/null', '-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${root}/known_hosts`, '-i', join(root, 'client'), 'root@127.0.0.1', 'true'], { stdio: 'pipe' }); break; }
    catch { if (attempt === 20) throw Error('Local SSH host unavailable'); await delay(500); }
  }
  session = sshSession({ address: '127.0.0.1', user: 'root', identityFile: join(root, 'client'), knownHostsFile: join(root, 'known_hosts'), port,
    directory: root, executablePath: process.env.PATH!, executorImage: executor, isolation, owner });
  const worker = await connectRemoteWorker({ remote: session, resources: {
    image: workerImage,
    cpu: 1, memoryMiB: 1024, timeoutSeconds: 300, configurationDigest: 'sha256:' + 'a'.repeat(64) },
    directory: root, owner, executablePath: process.env.PATH!, execute: runTrustedProcess, deadlineMs: Date.now() + 300000 });
  const source = join(root, 'source'); mkdirSync(source); mkdirSync(join(source, '.git'));
  writeFileSync(join(source, '.git', 'probe'), 'preserved'); writeFileSync(join(source, 'large'), Buffer.alloc(6 * 1048576, 'x'));
  await worker.load(source);
  assert.equal(await worker.run({ command: 'node', args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(worker.workspace + '/repository/.git/probe')},'utf8'))`],
    timeoutMs: 10000, maxOutputBytes: 1000 }), 'preserved');
  for (const bytes of [100, 1048576]) {
    const received = await worker.run({ command: 'node', args: ['-e', 'let bytes=0;process.stdin.on("data",chunk=>bytes+=chunk.length).on("end",()=>console.log(bytes))'],
      input: Buffer.alloc(bytes, 'x'), timeoutMs: 15000, maxOutputBytes: 1000 });
    assert.equal(Number(received.trim()), bytes);
    console.log(`Remote ${isolation} stdin: ${bytes} bytes passed`);
  }
  const isolated = await session.request<{ address: string }>('isolate', {}, 30000);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;
  await session.forward(isolated.address, gatewayPort);
  await session.request('connect', { port: gatewayPort }, 30000);
  await proveNetwork(worker, `http://${isolated.address}:${gatewayPort}/`, `http://${isolated.address}:1/`);
  assert.equal(hits, 1);
  await proveCredentialSeparation(worker, 'synthetic-host-secret-never-sent');
  await session.request('seal', {}, 30000);
  await session.request('close', {}, 60000);
  await session.close(); session = undefined;
  assert.equal(docker('ps', '-aq', '--filter', `name=ii-executor-${owner}`), '');
  assert.equal(docker('inspect', cacheConsumer, '--format', '{{.Name}}'), `/${cacheConsumer}`);
  console.log(`Remote host: pinned SSH, real ${isolation} worker, streamed gateway, denied internet, credential separation and cleanup passed`);
} finally {
  if (session) { try { await session.request('close', {}, 60000); } catch {} await session.close(); }
  gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
  if (created) docker('rm', '-f', name);
  if (consumerCreated) docker('rm', cacheConsumer);
  // Only remove this test's executor if its transport failed. Never remove unrelated host resources.
  if (docker('ps', '-aq', '--filter', `name=ii-executor-${owner}`)) docker('rm', '-f', `ii-executor-${owner}`);
  rmSync(root, { recursive: true, force: true });
}
