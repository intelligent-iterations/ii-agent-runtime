import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOptions } from '../src/worker.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-app-worker-')));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); writeFileSync(join(root, 'app.txt'), 'before\n'); git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  const bundle = join(root, 'source.bundle'); git('bundle', 'create', bundle, 'HEAD');
  const bytes = readFileSync(bundle);
  const binary = join(root, 'codex');
  writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');
if(process.argv[2]==='--version'){console.log('codex-cli 0.156.1');process.exit(0)}
if(process.argv[2]==='login'){
 let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:input.trim()}),{mode:0o600});process.exit(0)})
}else if(process.argv[2]==='exec'){
 if(process.env.CODEX_CODE_API_KEY||process.env.UNRELATED_TOKEN)process.exit(7);
 fs.writeFileSync('app.txt','after\\n');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));
}else process.exit(9);
`);
  chmodSync(binary, 0o700);
  const options: WorkerOptions = {
    directory: join(root, 'attempt'), codexBinary: binary, sourceBundlePath: bundle,
    environment: { CODEX_CODE_API_KEY: 'sk-synthetic-private', UNRELATED_TOKEN: 'must-not-enter' },
    input: { executionId: 'task', attemptId: 'attempt', task: 'Change app.txt', repository: 'org/app', baseCommit,
      sourceBundle: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
      role: { kind: 'code', authMode: 'api-key', credentialKey: 'CODEX_CODE_API_KEY', instructions: 'Edit only app.txt.',
        setup: { schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
          deployment: { provider: 'tart', options: factoryTartOptions(), image: `registry.example/worker@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 },
          secrets: [{ provider: 'github', repository: 'org/factory', key: 'CODEX_CODE_API_KEY' }], capture: { paths: ['candidate.bundle'] } } } },
  };
  return { root, options, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('normal coding worker seals a candidate without a GitHub credential or publication', async () => {
  const f = fixture();
  try {
    const result = await runWorker(f.options);
    assert.equal(result.state, 'completed');
    assert.equal(result.candidate?.baseCommit, f.options.input.baseCommit);
    assert.equal(result.artifacts[0]?.path, 'candidate.bundle');
    assert.equal(existsSync(join(f.options.directory, 'codex/auth.json')), false);
    assert.equal('branch' in result, false);
    assert.doesNotMatch(readFileSync(join(f.options.directory, 'result.json'), 'utf8'), /sk-synthetic-private/);
  } finally { f.close(); }
});

test('worker rejects a changed source bundle before Codex executes', async () => {
  const f = fixture();
  try {
    writeFileSync(f.options.sourceBundlePath!, 'changed');
    const result = await runWorker(f.options);
    assert.equal(result.state, 'failed');
    assert.equal(existsSync(join(result.workspace, 'app.txt')), false);
  } finally { f.close(); }
});

test('optional agent GitHub token is inspected from its actual worker context and redacted', async () => {
  const f = fixture(); const originalFetch = globalThis.fetch;
  try {
    f.options.input.role.githubPermissions = { issues: 'write' };
    f.options.environment.FACTORY_AGENT_GITHUB_TOKEN = 'synthetic-github-token';
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-github-token');
      return Response.json({ total_count: 1, repositories: [{ full_name: 'org/app', permissions: { push: false } }] });
    };
    const result = await runWorker(f.options);
    assert.equal(result.state, 'completed');
    assert.equal(result.githubTokenAudit?.visibleRepositories, 1);
    assert.doesNotMatch(readFileSync(join(f.options.directory, 'result.json'), 'utf8'), /synthetic-github-token/);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});
