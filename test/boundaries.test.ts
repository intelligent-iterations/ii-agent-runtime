import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBoundaries, importViolations } from '../scripts/check-boundaries.js';

const inspect = (code: string) => importViolations(code, '/package/src/example.ts', '/package/src');
test('architectural check rejects prohibited dependencies across supported loading syntax', () => {
  for (const code of [
    `import x from 'consumer-package';`, `export * from 'consumer-package';`,
    `const x = import('consumer-package');`, `const x = require('consumer-package');`,
    `import x from '../../neighbor/src/index.js';`, `type X = import('consumer-package').X;`,
    `const x = import(moduleName);`, `const r = createRequire(import.meta.url);`,
  ]) assert.ok(inspect(code).length > 0, code);
});
test('architectural check accepts standard libraries and package internals', () => {
  assert.deepEqual(inspect(`import { readFile } from 'node:fs'; export * from './setup.js'; import { Ajv } from 'ajv'; import { parseDocument } from 'yaml';`), []);
  assert.deepEqual(checkBoundaries(new URL('..', import.meta.url).pathname), []);
});

test('embedded examples cannot become runtime imports', () => {
  assert.ok(inspect(`import { createFactory } from '../example/agent-factory/src/index.js';`).length > 0);
});
