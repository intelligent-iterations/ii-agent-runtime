import { types } from 'node:util';

export const MAX_CONFIGURATION_BYTES = 1024 * 1024;
export class ConfigurationError extends Error {
  constructor(readonly code: string, readonly location?: { line: number; column: number }, readonly pointer?: string) {
    super(`Invalid configuration (${code})${location ? ` at line ${location.line}, column ${location.column}` : ''}`);
    this.name = 'ConfigurationError';
  }
}

/** RFC 8785 JSON serialization, rejecting executable or lossy JavaScript values. */
export function canonicalJson(input: unknown): string {
  let count = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const fail = (code: string): never => { throw new ConfigurationError(code); };
  const string = (value: string) => {
    if (!value.isWellFormed()) fail('UNICODE');
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_CONFIGURATION_BYTES) fail('SIZE');
    return JSON.stringify(value);
  };
  function encode(value: unknown, depth: number): string {
    if (++count > 50_000 || depth > 64) fail('COMPLEXITY');
    if (value === null || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object' || value === null || types.isProxy(value)) return fail('DATA');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) || ancestors.has(value)) fail('DATA');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 50_000 || (array && keys.length !== value.length + 1)) fail('DATA');
    ancestors.add(value);
    const fields = new Map<string, unknown>();
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return fail('DATA');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('DATA');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail('DATA');
      fields.set(key, descriptor.value);
    }
    const result = array
      ? `[${Array.from({ length: value.length }, (_, i) => encode(fields.get(String(i)), depth + 1)).join(',')}]`
      : `{${[...fields.keys()].sort().map(key => `${string(key)}:${encode(fields.get(key), depth + 1)}`).join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  const result = encode(input, 0);
  if (Buffer.byteLength(result) > MAX_CONFIGURATION_BYTES) fail('SIZE');
  return result;
}
