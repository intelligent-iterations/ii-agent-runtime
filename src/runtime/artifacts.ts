import { requireDirectory, readBounded } from './artifact-files.js';
import { constants, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, compileConfiguration, digest, type CompiledConfiguration } from './configuration.js';

interface ConfigurationManifest {
  schemaVersion: 1;
  kind: 'runtime-configuration';
  artifactDigest: string;
  setupDigest: string;
  bytes: number;
}
/** Creates a new owned directory. Existing directories and artifacts are never overwritten. */
export function saveConfigurationArtifact(parent: string, input: unknown): string {
  const root = requireDirectory(parent);
  const compiled = compileConfiguration(input);
  const path = join(root, `configuration-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  // Preserve an incomplete directory on error; callers can inspect its exact ownership.
  writeFileSync(join(path, '.owner'), randomUUID(), { flag: 'wx', mode: 0o600 });
  const descriptor = openSync(join(path, 'canonical.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(descriptor, compiled.canonical); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const manifest: ConfigurationManifest = { schemaVersion: 1, kind: 'runtime-configuration',
    artifactDigest: compiled.artifactDigest, setupDigest: compiled.setupDigest, bytes: Buffer.byteLength(compiled.canonical) };
  writeFileSync(join(path, 'manifest.pending'), canonicalJson(manifest), { flag: 'wx', mode: 0o600 });
  renameSync(join(path, 'manifest.pending'), join(path, 'manifest.json'));
  return path;
}

/** Expected identity comes from the trusted run record, not the downloaded manifest. */
export function loadConfigurationArtifact(directory: string, expectedArtifactDigest: string, maxBytes: number): CompiledConfiguration {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10485760 || !/^sha256:[a-f0-9]{64}$/.test(expectedArtifactDigest)) throw Error('Invalid artifact request');
  const root = requireDirectory(directory);
  const manifest = JSON.parse(readBounded(join(root, 'manifest.json'), 4096).toString('utf8')) as ConfigurationManifest;
  if (canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(['artifactDigest', 'bytes', 'kind', 'schemaVersion', 'setupDigest']) ||
    manifest.schemaVersion !== 1 || manifest.kind !== 'runtime-configuration' || !Number.isSafeInteger(manifest.bytes) || manifest.bytes > maxBytes) throw Error('Invalid artifact manifest');
  const bytes = readBounded(join(root, 'canonical.json'), maxBytes);
  if (bytes.length !== manifest.bytes || digest(bytes) !== expectedArtifactDigest || manifest.artifactDigest !== expectedArtifactDigest) throw Error('Artifact integrity mismatch');
  const compiled = compileConfiguration(JSON.parse(bytes.toString('utf8')));
  if (compiled.canonical !== bytes.toString('utf8') || compiled.setupDigest !== manifest.setupDigest) throw Error('Artifact is not the approved canonical configuration');
  return compiled;
}
