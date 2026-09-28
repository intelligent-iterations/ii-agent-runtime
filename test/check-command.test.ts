import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('check CLI requires fresh trusted evidence and fails closed without exposing checker output', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-check-'));
  const checker = join(root, 'checker');
  const trace = join(root, 'trace');
  const mode = join(root, 'mode');
  writeFileSync(
    checker,
    `#!${process.execPath}
const fs=require('node:fs');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
fs.appendFileSync(${JSON.stringify(trace)},request.operation+'\\n');
const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
if(mode==='failure'){console.error('synthetic-private-value');process.exit(1);}
if(mode==='timeout'){setTimeout(()=>{},10000);}
else if(mode==='malformed'){console.log('synthetic-private-value');}
else console.log(JSON.stringify(request.operation==='identify'?{subject:'operator'}:{status:mode,evidenceId:'fixture'}));
`,
    { mode: 0o700 },
  );
  const run = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('src/cli.ts'),
        'check',
        '--format',
        'yaml',
        resolve('test/fixtures/authoring-setup.yaml'),
        ...extra,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
  try {
    assert.equal(run().status, 3);
    for (const status of [
      'verified',
      'denied',
      'unknown',
      'failure',
      'malformed',
      'timeout',
    ]) {
      writeFileSync(mode, status);
      writeFileSync(trace, '');
      const result = run([
        '--checker',
        checker,
        '--timeout-ms',
        status === 'timeout' ? '100' : '2000',
      ]);
      assert.equal(result.status, status === 'verified' ? 0 : 3, result.stderr);
      assert.equal(
        JSON.parse(result.stdout).evidence.allowed,
        status === 'verified',
      );
      assert.ok(
        !(result.stdout + result.stderr).includes('synthetic-private-value'),
      );
      const operations = readFileSync(trace, 'utf8');
      if (status === 'verified')
        assert.equal(operations.match(/inspect-secret/g)?.length, 4);
      else assert.ok(!operations.includes('inspect-secret'));
    }
    assert.equal(run(['--timeout-ms', '0']).status, 2);
    assert.equal(run(['--checker', 'relative']).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
