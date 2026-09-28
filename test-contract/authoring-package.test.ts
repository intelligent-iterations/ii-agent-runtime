import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packed SDK and installed bin compile from an unrelated directory without factory files', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-authoring-package-'));
  try {
    const metadata = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { encoding: 'utf8' }))[0];
    assert.ok(!metadata.files.some((file: {path: string}) => file.path.startsWith('example/')));
    const cwd = join(root, 'consumer'); mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // Uses npm's cache from the normal dependency install; no registry/network required.
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(root, metadata.filename)], { cwd, stdio: 'pipe' });
    const result = spawnSync(join(cwd, 'node_modules/.bin/ii-agent-runtime'),
      ['compile', '--format', 'yaml', resolve('test/fixtures/authoring-setup.yaml')], { cwd, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    const golden = JSON.parse(readFileSync('test/fixtures/authoring-golden.json', 'utf8'));
    assert.equal(result.stdout, golden.json + '\n');
    writeFileSync(join(cwd, 'check.mjs'), `import {compileSetup,defineSetup} from '@intelligent-iterations/ii-agent-runtime';
import {readFileSync} from 'node:fs';
const setup=defineSetup(JSON.parse(readFileSync(0,'utf8'))); process.stdout.write(compileSetup(setup).json+'\\n');`);
    const imported = execFileSync(process.execPath, ['check.mjs'], { cwd,
      input: readFileSync('test/fixtures/authoring-setup.json'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(imported, result.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
