import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml';
import { canonicalJson, ConfigurationError, MAX_CONFIGURATION_BYTES } from './data.js';
import type { RuntimeConfiguration } from './configuration-types.js';

export type { RuntimeConfiguration } from './configuration-types.js';
export { canonicalJson, ConfigurationError } from './data.js';
const schema = JSON.parse(readFileSync(new URL('../../schemas/runtime-configuration.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: false }).compile<RuntimeConfiguration>(schema);
export interface CompiledConfiguration {
  configuration: RuntimeConfiguration;
  canonical: string;
  setupDigest: string;
  artifactDigest: string;
}
export const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function compileConfiguration(input: unknown): CompiledConfiguration {
  const configuration: unknown = JSON.parse(canonicalJson(input));
  if (!validate(configuration)) throw new ConfigurationError('SCHEMA', undefined, validate.errors?.[0]?.instancePath);
  const source = configuration.source;
  source.repository = source.repository.toLowerCase();
  const names = new Set([source.repository]);
  for (const grant of source.additionalRepositories) {
    grant.repository = grant.repository.toLowerCase();
    if (names.has(grant.repository)) throw new ConfigurationError('DUPLICATE_REPOSITORY');
    // One source credential (for example one App installation) serves the run, so every repository shares the owner.
    if (grant.repository.split('/')[0] !== source.repository.split('/')[0]) throw new ConfigurationError('INSTALLATION_OWNER');
    names.add(grant.repository);
  }
  source.additionalRepositories.sort((a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
  if (configuration.limits.maxCostMicrousdPerMonth < configuration.limits.maxModelCostMicrousdPerRun) throw new ConfigurationError('BUDGET');
  if (configuration.limits.maxRunsPerSubject > configuration.limits.maxRunsPerMonth) throw new ConfigurationError('RUN_LIMIT');
  const canonical = canonicalJson(configuration);
  const { revision: _revision, ...semantic } = configuration;
  return { configuration, canonical, setupDigest: digest(canonicalJson(semantic)), artifactDigest: digest(canonical) };
}

/** Optional build-time helper; runtime never imports a customer's configuration module. */
export function defineRuntime(input: RuntimeConfiguration): RuntimeConfiguration {
  return compileConfiguration(input).configuration;
}

/** Strict YAML subset: strings and JSON scalar spellings, without YAML coercions. */
function parseConfigurationDocument(source: string, format: 'json' | 'yaml') {
  if (Buffer.byteLength(source) > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('SIZE');
  if (format === 'json') {
    try { JSON.parse(source); } catch { throw new ConfigurationError('JSON_SYNTAX'); }
  }
  const lines = new LineCounter();
  const fail = (code: string, offset = 0): never => {
    const position = lines.linePos(offset);
    throw new ConfigurationError(code, { line: position.line, column: position.col });
  };
  let documents;
  try {
    documents = parseAllDocuments(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false,
      strict: true, prettyErrors: false, lineCounter: lines, logLevel: 'silent' });
  } catch { return fail('SYNTAX'); }
  if (documents.length !== 1) return fail('DOCUMENT_COUNT');
  const doc = documents[0]!;
  const error = doc.errors[0] ?? doc.warnings[0];
  if (error) return fail('SYNTAX', error.pos[0]);
  if (doc.directives?.yaml.explicit || Object.entries(doc.directives?.tags ?? {}).some(([key, value]) =>
    !((key === '!' && value === '!') || (key === '!!' && value === 'tag:yaml.org,2002:')))) return fail('DIRECTIVE');
  let nodes = 0;
  function inspect(node: unknown, depth: number): void {
    if (++nodes > 50_000 || depth > 64) fail('COMPLEXITY');
    if (isAlias(node)) fail('ALIAS', node.range?.[0]);
    if (!(isMap(node) || isSeq(node) || isScalar(node))) return fail('NODE');
    if (node.anchor || node.tag) fail('TAG_OR_ANCHOR', node.range?.[0]);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') fail('KEY', node.range?.[0]);
        inspect(pair.key, depth + 1);
        inspect(pair.value, depth + 1);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) inspect(item, depth + 1);
    } else if (node.type === 'PLAIN' && typeof node.value !== 'string' &&
      !/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(node.source ?? '')) fail('IMPLICIT_TYPE', node.range?.[0]);
  }
  inspect(doc.contents, 0);
  return {
    value: doc.toJS({ maxAliasCount: 0 }) as unknown,
    position(pointer: string) {
      const path = pointer ? pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
      const node = doc.getIn(path, true);
      const offset = (isMap(node) || isSeq(node) || isScalar(node)) ? node.range?.[0] ?? 0 : 0;
      const position = lines.linePos(offset);
      return { line: position.line, column: position.col };
    },
  };
}

export function parseConfigurationText(source: string, format: 'json' | 'yaml'): unknown {
  return parseConfigurationDocument(source, format).value;
}

export function compileConfigurationText(source: string, format: 'json' | 'yaml'): CompiledConfiguration {
  const parsed = parseConfigurationDocument(source, format);
  try { return compileConfiguration(parsed.value); }
  catch (error) {
    if (error instanceof ConfigurationError && error.pointer !== undefined) {
      throw new ConfigurationError(error.code, parsed.position(error.pointer), error.pointer);
    }
    throw error;
  }
}
