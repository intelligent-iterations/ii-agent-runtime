import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(
  readFileSync(new URL('../schemas/setup.json', import.meta.url), 'utf8'),
);
const result = await compile({ ...schema, title: 'Setup' }, 'Setup', {
  bannerComment:
    '// Generated from schemas/setup.json. Run npm run generate:types; do not edit.',
  style: { singleQuote: true },
  $refOptions: { resolve: { http: false, file: false } },
});
const path = new URL('../src/generated/setup.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== result)
    throw Error('Generated Setup types are stale; run npm run generate:types');
} else writeFileSync(path, result);
