import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('schema changes regenerate required fields and stale generated declarations fail the gate', () => {
  const root = mkdtempSync(resolve('.type-generation-'));
  try {
    for (const dir of ['scripts', 'schemas', 'src/generated'])
      mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(
      'scripts/generate-setup-types.ts',
      join(root, 'scripts/generate-setup-types.ts'),
    );
    const schema = JSON.parse(readFileSync('schemas/setup.json', 'utf8'));
    schema.properties.schemaProbe = { type: 'string' };
    schema.required.push('schemaProbe');
    writeFileSync(join(root, 'schemas/setup.json'), JSON.stringify(schema));
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(root, 'scripts/generate-setup-types.ts'),
          ...args,
        ],
        { encoding: 'utf8' },
      );
    assert.equal(run().status, 0);
    const generated = join(root, 'src/generated/setup.ts');
    assert.match(readFileSync(generated, 'utf8'), /schemaProbe: string/);
    assert.equal(run('--check').status, 0);
    writeFileSync(generated, '// stale');
    const failed = run('--check');
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /types are stale/);
    assert.equal(readFileSync(generated, 'utf8'), '// stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
