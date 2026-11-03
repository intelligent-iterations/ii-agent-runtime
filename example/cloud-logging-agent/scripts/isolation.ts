import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerTofuTarget, executionServices, type Isolation } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { startGateway } from '../src/gateway.js';
import { loadWorkerFiles } from '../src/worker-files.js';
if (process.platform !== 'linux') {
  // No simulated isolation test: the probe needs a real Linux Docker host.
  console.error('test:isolation needs a Linux Docker host. On macOS, run: npm run test:isolation:linux');
  process.exit(1);
}
const parent = mkdtempSync(join(tmpdir(), 'cloud-logging-isolation-'));
const target = dockerTofuTarget({ parent, executablePath: process.env.PATH!, services: executionServices });
let isolation: Isolation | undefined, gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let cleaned = false;
try {
  // Positive control: the trusted supervisor has network access before the worker's egress probes.
  assert.ok((await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(10000) })).ok);
  const worker = await target.provision({ image: 'node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd',
    cpu: 1, memoryMiB: 1024, timeoutSeconds: 300, configurationDigest: `sha256:${'a'.repeat(64)}` });
  // Only the explicitly selected worker files, never the application's host directory or credentials.
  await loadWorkerFiles(worker);
  isolation = await worker.isolate();
  gateway = await startGateway({ address: isolation.address, project: 'ii-demo-checkout', resourceType: 'cloud_function', resource: 'checkout',
    deadlineMs: Date.now() + 60000, signal: new AbortController().signal,
    resolveCredential: async () => { throw Error('A denied call must never resolve credentials'); },
    model: { respond: async () => new Response(null, { status: 403 }) } });
  await isolation.connect(gateway.port);
  console.log(await worker.run({ command: 'node', args: ['/workspace/repository/probe.mjs'],
    input: JSON.stringify({ endpoint: gateway.endpoint, token: gateway.token }), timeoutMs: 30000, maxOutputBytes: 4096 }));
} finally {
  const results = [];
  for (const close of [() => isolation?.close(), () => gateway?.close(), () => target.close()]) {
    try { await close(); } catch (error) { results.push(error); }
  }
  assert.equal(results.length, 0, 'all isolation and target cleanup must succeed');
  cleaned = true;
  rmSync(parent, { recursive: true });
}
assert.ok(cleaned);
console.log('Runtime target and firewall cleanup passed.');
