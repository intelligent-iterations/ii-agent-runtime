import { factoryTartOptions } from '../src/defaults.js';
/** Real guest verification with synthetic code; no harness, model or GitHub credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareTartDeployment, deployTart, startTartVM, executeTartGuest, captureTartFiles, destroyTart, inspectTartDeployment } from '@intelligent-iterations/ii-agent-runtime';
import { installVerificationEntry } from '../src/code-acceptance.js';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import { buildWorkerBundle, createGuestStager } from '../src/guest-stage.js';
import { sealCodeCandidate } from '../src/code-candidate.js';
import type { CodeVerificationInput, CodeVerificationResult } from '../src/code-verifier.js';
import type { ExecutionContext } from '../src/local-coordinator.js';
const [image, directory, mode] = process.argv.slice(2);
if (!image || !directory) throw Error('Usage: verify-code-guest.ts pinned-image new-evidence-directory');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const retained = join(root, 'retained'); const source = join(root, 'source'); mkdirSync(retained); mkdirSync(source);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Verification', GIT_AUTHOR_EMAIL: 'verification@localhost', GIT_COMMITTER_NAME: 'Verification', GIT_COMMITTER_EMAIL: 'verification@localhost' };
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init'); writeFileSync(join(source, 'answer.txt'), 'wrong'); git('add', '.'); git('commit', '-m', 'base');
const baseCommit = git('rev-parse', 'HEAD'); const baseBundle = join(root, 'base.bundle'); git('bundle', 'create', baseBundle, 'HEAD');
writeFileSync(join(source, 'answer.txt'), 'correct');
const candidate = await sealCodeCandidate({ workspace: source, directory: join(root, 'sealed'), baseCommit, secretValues: [] });
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const setup = { schemaVersion: 1, id: 'code-verifier-proof', revision: '1', harness: { name: 'verification', version: '1' },
  deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: ['verification.json'] } };
const manifest = prepareTartDeployment(root, setup, { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') });
const manifestPath = join(manifest.directory, 'manifest.json');
const context = { attemptId: manifest.operationId, task: { id: 'verification', input: JSON.stringify({ role: { setup }, task: 'Verify only' }) },
  record: () => null, checkpoint: (key: string, value: unknown) => writeFileSync(join(root, key + '.json'), JSON.stringify(value)) } as unknown as ExecutionContext;
let files: Awaited<ReturnType<typeof captureTartFiles>> = [];
try {
  await deployTart(manifestPath, { subject: 'verification', authorize: async () => ({ status: 'verified', evidenceId: 'explicit-verification' }), inspectSecret: async () => { throw Error('No secrets'); } });
  await startTartVM(manifestPath); console.log('Verification VM started');
  let ready = false;
  for (let i = 0; i < 45; i++) { try { await executeTartGuest(manifestPath, ['true']); ready = true; break; } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); }
  assert.ok(ready);
  const uid = Number((await executeTartGuest(manifestPath, ['id', '-u', 'agent'])).trim());
  const gid = Number((await executeTartGuest(manifestPath, ['id', '-g', 'agent'])).trim());
  const input: CodeVerificationInput = { executionId: 'code-proof', attemptId: manifest.operationId, candidate,
    baseBundle: { path: '/opt/factory/verification-input/base.bundle', sha256: hash(readFileSync(baseBundle)) },
    candidateBundlePath: '/opt/factory/verification-input/candidate.bundle', directory: '/opt/factory/verified', identity: { uid, gid },
    checks: [
      { id: 'answer', interpreter: '/usr/local/bin/node', timeoutMs: 1000, script: "if(process.getuid()===0)process.exit(9);process.stdout.write(require('node:fs').readFileSync('answer.txt'))", stdoutSha256: hash('correct') },
      { id: 'ownership', interpreter: '/usr/local/bin/node', timeoutMs: 1000, script: "const fs=require('node:fs');let denied=0;for(const p of [__filename,'answer.txt']){try{fs.writeFileSync(p,'tampered')}catch(e){if(e.code==='EACCES')denied++}}process.stdout.write(String(denied))", stdoutSha256: hash('2') },
    ] };
  const bundle = buildWorkerBundle();
  if (mode === '--actions-entry') {
    bundle.files['verify.sh'] = Buffer.from('#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /opt/factory/workload/dist/verification-entry.js\n').toString('base64');
    bundle.sha256 = hash(canonicalJson(bundle.files));
    context.task.input = JSON.stringify({ role: { setup }, verification: input });
  }
  await createGuestStager(bundle, 'a'.repeat(40))(context, { manifestPath });
  const payload = { 'base.bundle': readFileSync(baseBundle).toString('base64'), 'candidate.bundle': readFileSync(join(source, candidate.bundle)).toString('base64'), 'input.json': Buffer.from(JSON.stringify(input)).toString('base64') };
  await executeTartGuest(manifestPath, ['sudo', '-n', 'python3', '-c', "import sys,json,os,base64\nr='/opt/factory/verification-input';os.mkdir(r,0o700)\nfor n,b in json.load(sys.stdin).items():\n with open(r+'/'+n,'xb') as f:f.write(base64.b64decode(b))\n"], JSON.stringify(payload));
  const invoke = "import fs from 'node:fs';import{runCodeVerification}from'/opt/factory/workload/dist/code-verifier.js';const input=JSON.parse(fs.readFileSync('/opt/factory/verification-input/input.json'));console.log(JSON.stringify(await runCodeVerification(input)));";
  let result: CodeVerificationResult;
  if (mode === '--actions-entry') {
    await installVerificationEntry(manifestPath);
    await assert.rejects(executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', 'sudo', '-n', '/bin/sh', '/opt/factory/workload/verify.sh', 'extra']));
    await assert.rejects(executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', 'sudo', '-n', '/bin/sh', '-c', 'id']));
    await executeTartGuest(manifestPath, ['sudo', '-n', '-u', 'agent', 'sudo', '-n', '/bin/sh', '/opt/factory/workload/verify.sh']);
    result = JSON.parse(await executeTartGuest(manifestPath, ['sudo', '-n', 'cat', '/opt/factory/verified/verification.json']));
  } else result = JSON.parse(await executeTartGuest(manifestPath, ['sudo', '-n', '/usr/local/bin/node', '--input-type=module', '-e', invoke]));
  assert.equal(result.accepted, true); assert.equal(result.commit, candidate.commit); assert.equal(result.checks[1]!.passed, true);
  files = await captureTartFiles(manifestPath, { root: '/opt/factory/verified', paths: ['verification.json'], destination: retained });
  assert.deepEqual(JSON.parse(readFileSync(files[0]!.localPath, 'utf8')), result);
  writeFileSync(join(root, 'proof.json'), JSON.stringify({ operationId: manifest.operationId, uid, gid, mode: mode ?? 'direct', result, files }, null, 2));
  console.log('Exact candidate verified; agent cannot rewrite policy or source; evidence retained');
} finally {
  assert.equal((await destroyTart(manifestPath)).present, false);
  assert.equal((await inspectTartDeployment(manifestPath)).present, false);
  for (const file of files) assert.equal(hash(readFileSync(file.localPath)), file.sha256);
  writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ removed: true, independentlyAbsent: true, retained: files.length }));
  console.log('Verification VM absent; retained evidence rechecked');
}
