import { factoryTartOptions } from '../src/defaults.js';
/** Real staging/capture proof, with no model call or credential injection. */
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareTartDeployment, deployTart, startTartVM, executeTartGuest, captureTartFiles, destroyTart, inspectTartDeployment } from '@intelligent-iterations/ii-agent-runtime';
import { buildWorkerBundle, createGuestStager } from '../src/guest-stage.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

const [image, directory] = process.argv.slice(2);
if (!image || !directory) throw Error('Usage: verify-guest.ts pinned-image new-evidence-directory');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const output = join(root, 'retained'); mkdirSync(output, { mode: 0o700 });
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const setup = { schemaVersion: 1, id: 'guest-proof', revision: '1', harness: { name: 'codex', version: '0.156.1' },
  deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['binary.dat'] } };
const manifest = prepareTartDeployment(root, setup, { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') });
const manifestPath = join(manifest.directory, 'manifest.json');
const records = new Map<string, unknown>();
const context = { attemptId: manifest.operationId, task: { id: 'verification', input: JSON.stringify({ task: 'Stage only', role: { kind: 'code', authMode: 'api-key', credentialKey: 'CODEX_KEY', instructions: 'Stage only', setup } }) },
  record: (key: string) => records.get(key) ?? null, checkpoint: (key: string, value: unknown) => {
    records.set(key, value); writeFileSync(join(root, 'checkpoints.json'), JSON.stringify(Object.fromEntries(records), null, 2), { mode: 0o600 });
  } } as ExecutionContext;
let captured: Awaited<ReturnType<typeof captureTartFiles>> = [];
try {
  await deployTart(manifestPath, { subject: 'guest-verification', authorize: async () => ({ status: 'verified', evidenceId: 'explicit-verification' }), inspectSecret: async () => { throw Error('No secrets assigned'); } });
  assert.equal(existsSync(join(manifest.directory, 'tart', 'cache')), true, 'Image cache must exist before lifecycle verification');
  await startTartVM(manifestPath); console.log('Fresh guest started');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { await executeTartGuest(manifestPath, ['true']); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready);
  const bundle = buildWorkerBundle();
  await createGuestStager(bundle, 'a'.repeat(40))(context, { manifestPath });
  const loaded = await executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', '/usr/local/bin/node', '--input-type=module', '-e', "const m=await import('/opt/factory/workload/dist/worker.js'); if(typeof m.runWorker!=='function')process.exit(1); console.log('loaded');"]);
  assert.equal(loaded.trim(), 'loaded');
  await assert.rejects(executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', 'sh', '-c', 'echo tampered >> /opt/factory/workload/attempt.json']));
  await executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', 'python3', '-c', "open('/results/binary.dat','wb').write(bytes(range(251))*3000)"]);
  captured = await captureTartFiles(manifestPath, { root: '/results', paths: ['binary.dat'], destination: output });
  const expected = Buffer.concat(Array.from({ length: 3000 }, () => Buffer.from(Array.from({ length: 251 }, (_, n) => n))));
  assert.equal(captured[0]!.sha256, createHash('sha256').update(expected).digest('hex'));
  console.log('Staging, read-only ownership and multi-chunk capture verified');
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ operationId: manifest.operationId, bundleDigest: bundle.sha256, workerLoads: true, agentCannotRewriteStaging: true, captured }, null, 2));
} finally {
  const removed = await destroyTart(manifestPath);
  assert.equal(existsSync(join(manifest.directory, 'tart', 'cache')), false, 'Owned image cache must be reclaimed');
  // Tart inventory can recreate an empty cache directory while confirming absence.
  const observed = await inspectTartDeployment(manifestPath);
  assert.equal(removed.present, false); assert.equal(observed.present, false);
  assert.equal(existsSync(manifestPath), true, 'Recovery manifest must remain');
  for (const file of captured) assert.equal(createHash('sha256').update(readFileSync(file.localPath)).digest('hex'), file.sha256);
  writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ removed: true, independentlyAbsent: true, imageCacheRemoved: true, retainedFilesVerified: captured.length }));
  console.log('VM absent; retained bytes verified after removal');
}
