import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { canonicalJson, compileConfiguration, ConfigurationError, digest } from './configuration.js';
import type { ExecutionInputs as SchemaInputs } from './execution-input-types.js';

export type ExecutionInputs = SchemaInputs;
export interface CompiledExecutionInputs {
  inputs: ExecutionInputs;
  canonical: string;
  inputDigest: string;
  artifactDigest: string;
  setupDigest: string;
}
export interface ExecutionInputOptions {
  /** In-memory denylist supplied by the trusted integration. Never returned or retained. */
  secretValues?: readonly string[];
}
export interface ExecutionInputRecord {
  schemaVersion: 1;
  executionId: string;
  attemptId: string;
  inputDigest: string;
  artifactDigest: string;
  setupDigest: string;
  inputs: ExecutionInputs;
}

const schema = JSON.parse(readFileSync(new URL('../../schemas/execution-inputs.json', import.meta.url), 'utf8'));
const configurationSchema = JSON.parse(readFileSync(new URL('../../schemas/runtime-configuration.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true }).addSchema(configurationSchema).compile<SchemaInputs>(schema);
const identity = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function rejectSecrets(value: unknown, secrets: readonly string[]): void {
  if (typeof value === 'string') {
    if (secrets.some(secret => value.includes(secret))) throw new ConfigurationError('EXECUTION_SECRET');
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      rejectSecrets(key, secrets);
      rejectSecrets(child, secrets);
    }
  }
}
function sortUnique<T>(values: T[], key: (value: T) => string): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) throw new ConfigurationError('EXECUTION_DUPLICATE');
  values.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Record resolved inputs, not task policy. No provider calls, implicit store or artifact downloads. */
export function compileExecutionInputs(input: unknown, options: ExecutionInputOptions = {}): CompiledExecutionInputs {
  // The existing data boundary rejects executable values and bounds size/depth before schema validation.
  const snapshot: unknown = JSON.parse(canonicalJson(input));
  const secrets = options.secretValues ?? [];
  if (secrets.some(secret => typeof secret !== 'string' || !secret.length)) throw new ConfigurationError('EXECUTION_SECRET_FILTER');
  rejectSecrets(snapshot, secrets);
  if (!validate(snapshot)) throw new ConfigurationError('EXECUTION_SCHEMA');
  const configuration = compileConfiguration(snapshot.configuration);
  const inputs: ExecutionInputs = { ...snapshot, configuration: configuration.configuration };
  sortUnique(inputs.repositories, value => value.repository);
  sortUnique(inputs.artifacts, value => value.role);
  sortUnique(inputs.components, value => value.name);
  sortUnique(inputs.credentials, value => canonicalJson([value.provider, value.resource, value.key, value.assignment]));
  sortUnique(inputs.coverage, value => value.field);
  // Unknown capture is part of the initial input record, never an implied complete reconstruction.
  if (inputs.prompt.kind === 'unavailable' && !inputs.coverage.some(value => value.field === 'prompt')) {
    throw new ConfigurationError('EXECUTION_COVERAGE');
  }
  const canonical = canonicalJson(inputs);
  // Revision labels locate snapshots but do not change semantic input identity (D005/D030).
  const { revision: _revision, ...semanticConfiguration } = inputs.configuration;
  const semantic = { ...inputs, configuration: semanticConfiguration };
  return { inputs, canonical, inputDigest: digest(canonicalJson(semantic)), artifactDigest: digest(canonical), setupDigest: configuration.setupDigest };
}

/** Binds a detached snapshot to one attempt without putting execution identifiers in its digest. */
export function createExecutionInputRecord(input: unknown, execution: { executionId: string; attemptId: string },
  options: ExecutionInputOptions = {}): ExecutionInputRecord {
  if (typeof execution.executionId !== 'string' || typeof execution.attemptId !== 'string' ||
      !identity.test(execution.executionId) || !identity.test(execution.attemptId)) throw new ConfigurationError('EXECUTION_IDENTITY');
  const compiled = compileExecutionInputs(input, options);
  rejectSecrets(execution, options.secretValues ?? []);
  return { schemaVersion: 1, executionId: execution.executionId, attemptId: execution.attemptId,
    inputDigest: compiled.inputDigest, artifactDigest: compiled.artifactDigest, setupDigest: compiled.setupDigest, inputs: compiled.inputs };
}
