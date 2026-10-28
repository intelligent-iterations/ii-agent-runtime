import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PERMISSIONS } from '../src/onboarding-browser.js';

test('the Factory composes runtime adapters through the published package', () => {
  const directory = join(import.meta.dirname, '../src');
  for (const name of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(join(directory, name), 'utf8');
    // The runtime is a dependency: reached through its published package, never its source tree.
    assert.doesNotMatch(source, /from ['"](?:\.\.\/){2,}(?:src|test)\//, `${name} imports runtime internals`);
  }
});

test('Factory tests reach the runtime through its package, never its source tree', () => {
  for (const folder of ['../test', '../test-contract']) {
    const directory = join(import.meta.dirname, folder);
    for (const name of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
      assert.doesNotMatch(readFileSync(join(directory, name), 'utf8'), /['"](?:\.\.\/)+src\/(?:runtime|providers|pipeline)\//, `${folder}/${name}`);
    }
  }
});

test('the App manifest keeps the permissions the hub relies on', () => {
  assert.deepEqual(APP_PERMISSIONS, { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' });
});
