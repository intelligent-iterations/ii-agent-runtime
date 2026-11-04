import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

for (const [file, name, outputFile] of [
  ['runtime-configuration', 'RuntimeConfiguration', 'configuration-types'],
  ['execution-inputs', 'ExecutionInputs', 'execution-input-types'],
]) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}.json`, import.meta.url), 'utf8'));
  const target = new URL(`../src/runtime/${outputFile}.ts`, import.meta.url);
  const output = await compile(schema, name!, { cwd: fileURLToPath(new URL('../schemas/', import.meta.url)), bannerComment: `/* Generated from schemas/${file}.json. */`, style: { singleQuote: true }, additionalProperties: false, ignoreMinAndMaxItems: true });
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== output) throw Error('Runtime types are stale; run npm run generate:runtime-types');
  } else writeFileSync(target, output);
}
