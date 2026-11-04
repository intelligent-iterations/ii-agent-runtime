import { canonicalJson, compileConfiguration, ConfigurationError, type CompiledConfiguration, type RuntimeConfiguration } from './configuration.js';
import { createExecutionInputRecord, type ExecutionInputRecord } from './execution-inputs.js';

export type CredentialBinding = NonNullable<RuntimeConfiguration['credentialBindings']>[number];
export interface CredentialResolutionContext {
  executionId: string;
  attemptId: string;
  inputDigest: string;
  deadlineMs: number;
  signal: AbortSignal;
}
/** Provider mechanics and key material remain in the selected trusted adapter. */
export interface CredentialBindingProvider<Handle> {
  id: string;
  resolve(reference: Readonly<CredentialBinding>, context: CredentialResolutionContext): Promise<Handle>;
}

/** Exact reference/assignment enforcement; this is neither a vault nor a Grant evaluator. */
export function createCredentialResolver<Handle>(compiled: CompiledConfiguration, provider: CredentialBindingProvider<Handle>) {
  const checked = compileConfiguration(compiled.configuration);
  if (checked.canonical !== compiled.canonical || checked.artifactDigest !== compiled.artifactDigest || checked.setupDigest !== compiled.setupDigest ||
      typeof provider?.id !== 'string' || typeof provider.resolve !== 'function') throw new ConfigurationError('CREDENTIAL_RESOLVER_BINDING');
  const allowed = new Set((checked.configuration.credentialBindings ?? []).map(binding => canonicalJson(binding)));
  return {
    async resolve(record: ExecutionInputRecord, reference: CredentialBinding,
      options: { deadlineMs: number; signal: AbortSignal }): Promise<Handle> {
      // Reconstruct the snapshot rather than trusting caller-supplied hashes.
      const expected = createExecutionInputRecord(record.inputs, record);
      const configuration = compileConfiguration(expected.inputs.configuration);
      if (canonicalJson(expected) !== canonicalJson(record) || configuration.artifactDigest !== checked.artifactDigest) {
        throw new ConfigurationError('CREDENTIAL_INPUT_BINDING');
      }
      const key = canonicalJson(reference);
      if (!allowed.has(key) || reference.provider !== provider.id ||
          !expected.inputs.credentials.some(binding => canonicalJson(binding) === key)) throw new ConfigurationError('CREDENTIAL_DENIED');
      if (!(options.signal instanceof AbortSignal) || options.signal.aborted || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= Date.now()) {
        throw new ConfigurationError('CREDENTIAL_INTERRUPTED');
      }
      const context = { executionId: record.executionId, attemptId: record.attemptId, inputDigest: record.inputDigest,
        deadlineMs: options.deadlineMs, signal: options.signal };
      let handle: Handle;
      try { handle = await provider.resolve(Object.freeze(JSON.parse(key) as CredentialBinding), context); }
      catch { throw new ConfigurationError('CREDENTIAL_PROVIDER_FAILED'); }
      if (options.signal.aborted || Date.now() >= options.deadlineMs) throw new ConfigurationError('CREDENTIAL_INTERRUPTED');
      if (handle === undefined || handle === null) throw new ConfigurationError('CREDENTIAL_PROVIDER_FAILED');
      return handle;
    },
  };
}
