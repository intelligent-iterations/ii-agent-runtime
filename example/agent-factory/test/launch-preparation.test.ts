import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryAcceptance } from '../src/launch-preparation.js';

test('automatic repository verification runs real tests and detects a changed behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-test-selection-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.cjs' } }));
    writeFileSync(join(root, 'app.cjs'), 'module.exports = (a,b) => a+b;');
    writeFileSync(join(root, 'test.cjs'), "require('node:assert/strict').equal(require('./app.cjs')(2,3),5)");
    const check = repositoryAcceptance(root)[0]!;
    execFileSync(check.interpreter, ['-c', check.script], { cwd: root, stdio: 'pipe' });
    writeFileSync(join(root, 'app.cjs'), 'module.exports = (a,b) => a-b;');
    assert.throws(() => execFileSync(check.interpreter, ['-c', check.script], { cwd: root, stdio: 'pipe' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing tests and unlocked dependencies need an explicit command; no repository code runs during selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-test-selection-'));
  try {
    assert.throws(() => repositoryAcceptance(root), /add verify/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.throws(() => repositoryAcceptance(root), /add verify/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' }, dependencies: { example: '1' } }));
    assert.throws(() => repositoryAcceptance(root), /package-lock/);
    assert.equal(repositoryAcceptance(root, 'make test')[0]!.script, 'set -eu\nmake test');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
