import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, ConfigurationError, digest } from './configuration.js';
import { readBounded, requireDirectory } from './artifact-files.js';
import { compileExecutionInputs, type CompiledExecutionInputs, type ExecutionInputOptions } from './execution-inputs.js';

function parseRecord(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ConfigurationError('EXECUTION_ARTIFACT_JSON'); }
}

function syncFile(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Immutable input artifact. The consumer owns retention; external references are not fetched or attested. */
export function saveExecutionInputsArtifact(parent: string, input: unknown, options: ExecutionInputOptions = {}): string {
  const compiled = compileExecutionInputs(input, options);
  const root = requireDirectory(parent);
  const path = join(root, `execution-inputs-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  // A partial write remains owned and inspectable; never overwrite or delete another attempt's record.
  syncFile(join(path, '.owner'), randomUUID());
  syncFile(join(path, 'canonical.json'), compiled.canonical);
  syncFile(join(path, 'manifest.json'), canonicalJson({ schemaVersion: 1, kind: 'execution-inputs',
    artifactDigest: compiled.artifactDigest, inputDigest: compiled.inputDigest, setupDigest: compiled.setupDigest,
    bytes: Buffer.byteLength(compiled.canonical) }));
  syncDirectory(path);
  syncDirectory(root);
  return path;
}

/** The expected digest must come from a trusted run record, independently of the artifact. */
export function loadExecutionInputsArtifact(directory: string, expectedArtifactDigest: string, maxBytes: number,
  options: ExecutionInputOptions = {}): CompiledExecutionInputs {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || !/^sha256:[a-f0-9]{64}$/.test(expectedArtifactDigest)) {
    throw new ConfigurationError('EXECUTION_ARTIFACT_REQUEST');
  }
  const root = requireDirectory(directory);
  const manifest = parseRecord(readBounded(join(root, 'manifest.json'), 4096).toString('utf8')) as Record<string, unknown> | null;
  if (!manifest || canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(['artifactDigest', 'bytes', 'inputDigest', 'kind', 'schemaVersion', 'setupDigest']) ||
      manifest.schemaVersion !== 1 || manifest.kind !== 'execution-inputs' || !Number.isSafeInteger(manifest.bytes) || typeof manifest.bytes !== 'number' || manifest.bytes < 1 || manifest.bytes > maxBytes) {
    throw new ConfigurationError('EXECUTION_ARTIFACT_MANIFEST');
  }
  const bytes = readBounded(join(root, 'canonical.json'), maxBytes);
  if (bytes.length !== manifest.bytes || digest(bytes) !== expectedArtifactDigest || manifest.artifactDigest !== expectedArtifactDigest) {
    throw new ConfigurationError('EXECUTION_ARTIFACT_INTEGRITY');
  }
  const compiled = compileExecutionInputs(parseRecord(bytes.toString('utf8')), options);
  if (compiled.canonical !== bytes.toString('utf8') || compiled.inputDigest !== manifest.inputDigest || compiled.setupDigest !== manifest.setupDigest) {
    throw new ConfigurationError('EXECUTION_ARTIFACT_IDENTITY');
  }
  return compiled;
}
