import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, isIPv4 } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runTrustedProcess } from '../../shared/process.js';
import type { OpenShellHost } from '../openshell/target.js';

/** Infrastructure for one executor session. Workload credentials stay on the initiating host. */
export async function openOpenShellHost(parent: string, executablePath: string, signal: AbortSignal): Promise<{
  host: OpenShellHost; close(): Promise<void>;
}> {
  const root = join(parent, 'openshell');
  mkdirSync(root, { mode: 0o700 });
  const config = join(root, 'config'), state = join(root, 'state'), tls = join(root, 'tls');
  mkdirSync(config, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const env = { PATH: executablePath, HOME: root, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state,
    OPENSHELL_TELEMETRY_ENABLED: 'false', OPENSHELL_COLOR: 'never' };
  const run = (command: string, args: string[], timeoutMs = 10000) => runTrustedProcess({ command, args,
    cwd: root, env, signal, timeoutMs, maxOutputBytes: 1048576 });
  const route = JSON.parse(await run('ip', ['-j', 'route', 'get', '1.1.1.1']));
  const address: unknown = route[0]?.prefsrc;
  if (typeof address !== 'string' || !isIPv4(address) || /^(127|169\.254|0)\./.test(address)) throw Error('OpenShell host has no reachable IPv4 address');
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, address, resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const name = 'ii-' + randomBytes(8).toString('hex');
  const endpoint = `https://${address}:${port}`;
  await run('openshell-gateway', ['generate-certs', '--output-dir', tls, '--server-san', address, '--server-san', 'host.openshell.internal']);
  const q = JSON.stringify;
  const configuration = `[openshell]
version = 2
[openshell.gateway]
name = ${q(name)}
bind_address = ${q(`${address}:${port}`)}
compute_driver = "docker"
guest_tls_ca = ${q(join(tls, 'ca.crt'))}
guest_tls_cert = ${q(join(tls, 'client/tls.crt'))}
guest_tls_key = ${q(join(tls, 'client/tls.key'))}
[openshell.gateway.tls]
cert_path = ${q(join(tls, 'server/tls.crt'))}
key_path = ${q(join(tls, 'server/tls.key'))}
client_ca_path = ${q(join(tls, 'ca.crt'))}
[openshell.gateway.mtls_auth]
enabled = true
[openshell.gateway.gateway_jwt]
signing_key_path = ${q(join(tls, 'jwt/signing.pem'))}
public_key_path = ${q(join(tls, 'jwt/public.pem'))}
kid_path = ${q(join(tls, 'jwt/kid'))}
gateway_id = ${q(name)}
[openshell.drivers.docker]
sandbox_runtime_image = "ghcr.io/nvidia/openshell/sandbox:0.1.2"
supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.1.2"
image_pull_policy = "if_not_present"
sandbox_label = ${q(name)}
grpc_endpoint = ${q(endpoint)}
app_armor_profile = "Unconfined"
`;
  const path = join(root, 'gateway.toml');
  writeFileSync(path, configuration, { mode: 0o600, flag: 'wx' });
  await run('openshell-gateway', ['config', 'preflight', '--path', path]);
  if (signal.aborted) throw Error('OpenShell host bootstrap canceled');
  const child = spawn('openshell-gateway', ['--config', path], { cwd: root, env, stdio: 'ignore' });
  let exited = false;
  const stopped = new Promise<void>(resolve => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('close', () => { exited = true; resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    signal.removeEventListener('abort', abort);
    if (!exited) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
    try { await stopped; } finally { clearTimeout(timer); }
  })();
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw Error('OpenShell host bootstrap canceled');
    const client = join(config, 'openshell/gateways/remote/mtls');
    mkdirSync(client, { recursive: true, mode: 0o700 });
    for (const [source, dest] of [['ca.crt', 'ca.crt'], ['client/tls.crt', 'tls.crt'], ['client/tls.key', 'tls.key']] as const) {
      copyFileSync(join(tls, source), join(client, dest));
    }
    await run('openshell', ['gateway', 'add', endpoint, '--local', '--name', 'remote']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (exited || signal.aborted) throw Error('OpenShell host bootstrap interrupted');
      try {
        const status = JSON.parse(await run('openshell', ['status', '--output', 'json'], 1000));
        ready = status.status === 'connected' && status.version === '0.1.2';
      } catch { /* Gateway startup is bounded; a failed readiness probe does not grant execution. */ }
      if (ready) break;
      await delay(500, undefined, { signal });
    }
    if (!ready) throw Error('OpenShell gateway readiness timed out');
    await run('openshell', ['settings', 'set', '--global', '--key', 'agent_policy_proposals_enabled', '--value', 'false', '--yes']);
    return { host: { gatewayAddress: address, configDirectory: config }, close };
  } catch (error) { await close(); throw error; }
}
