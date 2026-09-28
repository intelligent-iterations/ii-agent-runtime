import { getCallSites, types } from 'node:util';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml';
import { canonicalJson, parseSetup, setupDigest, SetupValidationError, type Setup } from './setup.js';

export const SETUP_SOURCE_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 50_000;
export interface CompilationIssue { path: string; keyword: string; line?: number; column?: number }
export class SetupCompilationError extends Error {
  constructor(readonly code: string, message: string, readonly line?: number, readonly column?: number,
    readonly issues: CompilationIssue[] = [], readonly source?: string) {
    super(message); this.name = 'SetupCompilationError';
  }
}
export interface CompiledSetup { setup: Setup; json: string; digest: string }
function invalid(code: string, message: string): never { throw new SetupCompilationError(code, message); }

/** Inspect descriptors without invoking accessors, toJSON hooks or proxy traps. */
function assertData(input: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const count = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > SETUP_SOURCE_MAX_BYTES) invalid('INPUT_LIMIT', 'Setup exceeds the input limit');
  };
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid('INPUT_LIMIT', 'Setup exceeds the structure limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { count(value); return; }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || types.isProxy(value)) invalid('INVALID_DATA', 'Expected finite JSON data');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) || ancestors.has(value)) {
      invalid('INVALID_DATA', 'Expected acyclic plain JSON data');
    }
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODES) invalid('INPUT_LIMIT', 'Setup exceeds the structure limit');
    if (array && keys.length !== (value as unknown[]).length + 1) invalid('INVALID_DATA', 'Sparse or augmented arrays are not JSON');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalid('INVALID_DATA', 'Symbol keys are not JSON');
      count(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (value as unknown[]).length))) {
        invalid('INVALID_DATA', 'Accessors and hidden or augmented fields are not JSON');
      }
      walk(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  walk(input, 0);
}

/** Shared offline compiler. The returned JSON is the existing normalized setup contract. */
export function compileSetup(input: unknown): CompiledSetup {
  assertData(input);
  let setup: Setup;
  try { setup = parseSetup(input); }
  catch (error) {
    throw new SetupCompilationError('INVALID_SETUP', error instanceof Error ? error.message : 'Invalid setup', undefined, undefined,
      error instanceof SetupValidationError ? error.issues : []);
  }
  const json = canonicalJson(setup);
  if (Buffer.byteLength(json) > SETUP_SOURCE_MAX_BYTES) invalid('INPUT_LIMIT', 'Compiled setup exceeds the input limit');
  return { setup, json, digest: setupDigest(setup) };
}

/** Use in the caller's TypeScript build; no configuration module is loaded by runtime. */
export function defineSetup(input: Setup): Setup {
  try { return compileSetup(input).setup; }
  catch (error) {
    if (!(error instanceof SetupCompilationError)) throw error;
    const caller = getCallSites(2, { sourceMap: true })[1];
    throw new SetupCompilationError(error.code, error.message, caller?.lineNumber, caller?.columnNumber,
      error.issues, caller?.scriptName);
  }
}
function checkSource(source: string): void {
  if (typeof source !== 'string') invalid('INVALID_DATA', 'Expected setup source text');
  if (Buffer.byteLength(source) > SETUP_SOURCE_MAX_BYTES) invalid('INPUT_LIMIT', 'Setup source exceeds the input limit');
}
export function compileSetupJson(source: string): CompiledSetup {
  checkSource(source);
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return invalid('JSON_SYNTAX', 'Invalid JSON syntax'); }
  return compileSetup(value);
}

/** YAML 1.2 core strings with JSON spellings for numbers, booleans and null. */
export function compileSetupYaml(source: string): CompiledSetup {
  checkSource(source);
  const lines = new LineCounter();
  const fail = (code: string, offset = 0): never => {
    const position = lines.linePos(offset);
    throw new SetupCompilationError(code, 'Invalid or unsupported YAML syntax', position.line, position.col);
  };
  let documents;
  try {
    documents = parseAllDocuments(source, { version: '1.2', schema: 'core', uniqueKeys: true,
      merge: false, prettyErrors: false, strict: true, lineCounter: lines, logLevel: 'silent' });
  } catch { return fail('YAML_SYNTAX'); }
  if (documents.length !== 1) return fail('YAML_DOCUMENTS');
  const doc = documents[0]!;
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) return fail('YAML_SYNTAX', problem.pos[0]);
  if (doc.directives?.yaml.explicit || Object.entries(doc.directives?.tags ?? {}).some(([key, value]) =>
      !((key === '!' && value === '!') || (key === '!!' && value === 'tag:yaml.org,2002:')))) return fail('YAML_DIRECTIVE');
  let nodes = 0;
  const positions = new Map<string, number>();
  const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const walk = (node: unknown, depth: number, path = ''): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid('INPUT_LIMIT', 'Setup exceeds the structure limit');
    if (isAlias(node)) fail('YAML_ALIAS', node.range?.[0]);
    if (isMap(node) || isSeq(node) || isScalar(node)) {
      positions.set(path, node.range?.[0] ?? 0);
      if (node.anchor || node.tag) fail('YAML_TAG_OR_ANCHOR', node.range?.[0]);
      if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') fail('YAML_KEY', node.range?.[0]);
          const key = String((pair.key as { value: string }).value);
          walk(pair.key, depth + 1, path + '/' + pointer(key));
          walk(pair.value, depth + 1, path + '/' + pointer(key));
        }
      } else if (isSeq(node)) {
        for (const [index, item] of node.items.entries()) walk(item, depth + 1, path + '/' + index);
      } else if (node.type === 'PLAIN' && typeof node.value !== 'string') {
        if (!/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(node.source ?? '')) fail('YAML_SCALAR', node.range?.[0]);
      }
    } else if (node === null) fail('YAML_SCALAR');
    else fail('YAML_SYNTAX');
  };
  walk(doc.contents, 0);
  try { return compileSetup(doc.toJS({ maxAliasCount: 0 })); }
  catch (error) {
    if (!(error instanceof SetupCompilationError)) throw error;
    const issues = error.issues.map(issue => {
      const position = lines.linePos(positions.get(issue.path) ?? positions.get('') ?? 0);
      return { ...issue, line: position.line, column: position.col };
    });
    throw new SetupCompilationError(error.code, error.message, issues[0]?.line, issues[0]?.column, issues);
  }
}
