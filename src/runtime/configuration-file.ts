import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { compileConfigurationText, parseConfigurationText, type CompiledConfiguration } from './configuration.js';
import { ConfigurationError, MAX_CONFIGURATION_BYTES } from './data.js';

/** Authoring files are data only. Builders execute explicitly at build time and emit JSON. */
function readConfigurationFile(path: string) {
  const extension = extname(path).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(extension)) throw new ConfigurationError('FILE_FORMAT');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('FILE_SIZE');
    const buffer = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || length > MAX_CONFIGURATION_BYTES) throw new ConfigurationError('FILE_CHANGED');
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new ConfigurationError('UTF8'); }
    return { source, format: extension === '.json' ? 'json' as const : 'yaml' as const };
  } finally { closeSync(descriptor); }
}

export function compileConfigurationFile(path: string): CompiledConfiguration {
  const { source, format } = readConfigurationFile(path);
  return compileConfigurationText(source, format);
}

export function parseConfigurationFile(path: string): unknown {
  const { source, format } = readConfigurationFile(path);
  return parseConfigurationText(source, format);
}
