import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../test/runtime-fixture.js';

// Run from example/software-factory after building the runtime at the repository root.

// Real package installation + subprocess boundaries; no GitHub or model calls.
test('installed Factory CLI and optional builder share canonical identities and reject executable authoring', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-package-'));
  const owner = randomUUID();
  const marker = join(root, '.owner');
  writeFileSync(marker, owner, { flag: 'wx' });
  const repo = resolve(import.meta.dirname, '../../..');
  const pack = (cwd: string) => JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd, encoding: 'utf8' }))[0].filename as string;
  try {
    const runtime = pack(repo);
    const factory = pack(join(repo, 'example/software-factory'));
    const cwd = join(root, 'consumer'); mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(root, runtime), join(root, factory)], { cwd, stdio: 'pipe' });
    const cli = join(cwd, 'node_modules/.bin/software-factory');
    const run = (args: string[]) => spawnSync(cli, args, { cwd, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } });
    writeFileSync(join(cwd, 'runtime.json'), JSON.stringify(fixture(), null, 2));
    const validated = run(['validate', 'runtime.json']);
    assert.equal(validated.status, 0, validated.stderr);
    const identities = JSON.parse(validated.stdout);
    mkdirSync(join(cwd, 'artifacts'));
    const compiled = run(['compile', 'runtime.json', '--output-directory', 'artifacts']);
    assert.equal(compiled.status, 0, compiled.stderr);
    const artifact = JSON.parse(compiled.stdout);
    assert.equal(artifact.artifactDigest, identities.artifactDigest);
    writeFileSync(join(cwd, 'builder.mjs'), `import {defineRuntime,canonicalJson} from '@intelligent-iterations/ii-agent-runtime/runtime';
import {readFileSync} from 'node:fs';
process.stdout.write(canonicalJson(defineRuntime(JSON.parse(readFileSync('runtime.json','utf8')))));`);
    const built = execFileSync(process.execPath, ['builder.mjs'], { cwd, encoding: 'utf8' });
    assert.equal(`sha256:${createHash('sha256').update(built).digest('hex')}`, identities.artifactDigest);
    const invalid = fixture();
    invalid.limits.timeoutMinutes = -1;
    writeFileSync(join(cwd, 'runtime.json'), JSON.stringify(invalid));
    const rejected = run(['validate', 'runtime.json']);
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /SCHEMA/); assert.equal(rejected.stdout, '');
    writeFileSync(join(cwd, 'executable.ts'), 'throw new Error("EXECUTED_CUSTOMER_CODE");');
    const executable = run(['validate', 'executable.ts']);
    assert.equal(executable.status, 1); assert.match(executable.stderr, /FILE_FORMAT/); assert.doesNotMatch(executable.stderr, /EXECUTED_CUSTOMER_CODE/);
    const launch = run(['hub-launch']);
    assert.equal(launch.status, 1); assert.match(launch.stderr, /hub workflow on a GitHub-hosted runner/);
  } finally {
    assert.equal(readFileSync(marker, 'utf8'), owner);
    rmSync(root, { recursive: true });
  }
});
