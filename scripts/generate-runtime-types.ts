import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';

const schema = JSON.parse(readFileSync(new URL('../schemas/runtime-configuration.json', import.meta.url), 'utf8'));
const target = new URL('../src/runtime/configuration-types.ts', import.meta.url);
const output = await compile(schema, 'RuntimeConfiguration', { bannerComment: '/* Generated from schemas/runtime-configuration.json. */', style: { singleQuote: true }, additionalProperties: false, ignoreMinAndMaxItems: true });
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw Error('Runtime types are stale; run npm run generate:types');
} else writeFileSync(target, output);
