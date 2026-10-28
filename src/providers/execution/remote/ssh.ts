import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { commandSession, type RemoteSession } from './channel.js';

export interface SshSessionOptions {
  address: string;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  port?: number;
  directory: string;
  executablePath: string;
  executorImage: string;
  isolation: 'docker' | 'openshell';
  owner: string;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function sshSession(options: SshSessionOptions): RemoteSession {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(options.address) || !/^[a-z_][a-z0-9_-]*$/.test(options.user) ||
    !/^[a-f0-9]{32}$/.test(options.owner) || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(options.executorImage)) throw Error('Invalid infrastructure SSH destination');
  const args = ['-F', '/dev/null', '-T', '-p', String(options.port ?? 22),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'UserKnownHostsFile=' + realpathSync(options.knownHostsFile), '-i', realpathSync(options.identityFile)];
  const host = `${options.user}@${options.address}`;
  const command = ['sudo', '-n', 'docker', 'run', '--rm', '--interactive', '--name', `ii-executor-${options.owner}`,
    '--network', 'host', '--cap-add', 'NET_ADMIN',
    '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount', 'type=bind,source=/var/lib/ii-runtime,target=/var/lib/ii-runtime',
    options.executorImage, options.isolation];
  const env = { PATH: options.executablePath };
  const child: ChildProcessWithoutNullStreams = spawn('ssh', [...args, host, command.map(quote).join(' ')], { cwd: options.directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Drain diagnostic output; it is not part of the protocol and may contain account details.
  child.stderr.on('data', () => {});
  let stopped = false;
  child.on('close', () => { stopped = true; });
  child.on('error', error => child.stdout.destroy(error));
  return commandSession(child.stdin, child.stdout, async () => {
    if (stopped) return;
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  });
}
