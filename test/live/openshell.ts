import { dockerTofuTarget } from '../../src/providers/execution/docker/target.js';
import { executionServices } from '../../src/providers/services.js';
import { proveNetwork, proveCredentialSeparation } from './conformance.js';
import { workerResources } from '../../src/pipeline/worker-resources.js';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openshellTarget } from '../../src/providers/execution/openshell/target.js';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { runTrustedProcess } from '../../src/providers/shared/process.js';
import { fixture } from '../runtime-fixture.js';

const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-live-')));
const provider = process.env.TEST_EXECUTION_PROVIDER ?? 'openshell';
assert.ok(['docker', 'openshell'].includes(provider));
const target = provider === 'docker' ? dockerTofuTarget({ parent, executablePath: process.env.PATH!, services: executionServices }) : openshellTarget({ parent, executablePath: process.env.PATH!,
  ...(process.env.OPENSHELL_TEST_GATEWAY_ADDRESS ? { host: { gatewayAddress: process.env.OPENSHELL_TEST_GATEWAY_ADDRESS } } : {}), process: async request => {
  const output = await runTrustedProcess(request);
  return output;
} });
const config = fixture();
const compiled = compileConfiguration({ ...config, environment: { ...config.environment, provider: provider as 'docker' | 'openshell', cpu: 1, memoryMiB: 1024,
  image: 'node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c' } });
const marker = 'synthetic-provider-canary-4fda437ef96c';
let allowed = 0, forbidden = 0, authenticatedUpstreamRequests = 0;
const upstream = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${marker}`) { res.writeHead(401); res.end(); return; }
  authenticatedUpstreamRequests++; res.end('accepted');
});
const gateway = createServer((_req, res) => {
  allowed++;
  // The trusted gateway uses the synthetic provider credential; the worker never receives it.
  void fetch(`http://127.0.0.1:${(upstream.address() as { port: number }).port}/`, {
    headers: { Authorization: `Bearer ${marker}` }, signal: AbortSignal.timeout(3000),
  }).then(async response => {
    await response.text();
    if (!response.ok) throw Error('Synthetic upstream refused gateway credential');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n');
    setTimeout(() => res.end('data: last\n\n'), 50);
  }).catch(() => { res.writeHead(502); res.end(); });
});
const outside = createServer((_req, res) => { forbidden++; res.end('outside'); });
try {
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const worker = await target.provision(workerResources(compiled));
  const source = join(parent, 'source'); mkdirSync(source); mkdirSync(join(source, '.git')); writeFileSync(join(source, '.git', 'probe'), 'preserved');
  await worker.load(source);
  const loaded = await worker.run({ command: 'node', args: ['-e', `console.log(require("fs").readFileSync(${JSON.stringify(worker.workspace + '/repository/.git/probe')},"utf8"))`], timeoutMs: 10000, maxOutputBytes: 1000 });
  assert.equal(loaded.trim(), 'preserved');
  const isolation = await worker.isolate();
  await new Promise<void>(resolve => gateway.listen(0, isolation.address, resolve));
  await new Promise<void>(resolve => outside.listen(0, isolation.address, resolve));
  const port = (gateway.address() as { port: number }).port;
  const deniedPort = (outside.address() as { port: number }).port;
  await isolation.connect(port);
  await proveNetwork(worker, `http://${isolation.address}:${port}/`, `http://${isolation.address}:${deniedPort}/`);
  assert.equal(allowed, 1); assert.equal(forbidden, 0);
  assert.equal(authenticatedUpstreamRequests, 1, 'gateway must authenticate to the synthetic provider');
  const credentials = await proveCredentialSeparation(worker, marker);
  await assert.rejects(proveNetwork({ run: request => runTrustedProcess({ ...request, command: process.execPath,
    cwd: parent, env: { PATH: process.env.PATH! } }) }, `http://${isolation.address}:${port}/`, `http://${isolation.address}:${deniedPort}/`), /outside route must be denied/);
  assert.equal(forbidden, 1, 'outside listener must detect the deliberately unrestricted control');
  console.log(JSON.stringify({ provider, policy: 'verified', sourceGitDirectory: 'preserved', streaming: 'passed', directEgress: 'denied',
    outsideListenerRequestsFromSandbox: 0, unrestrictedControlRejected: true, gatewayProviderCredentialUsed: true, credentials }));
  await isolation.close();
} finally {
  gateway.close(); outside.close(); upstream.close();
  await target.close();
  rmSync(parent, { recursive: true });
}
console.log(`${provider} target cleanup confirmed`);
