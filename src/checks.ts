import { parseSetup, setupDigest, type SecretReference, type Setup } from './setup.js';

export type CheckStatus = 'verified' | 'denied' | 'unknown';
export interface Observation {
  status: CheckStatus;
  /** Stable evidence identifier supplied by the trusted adapter, never credential material. */
  evidenceId: string;
}
export interface CheckContext {
  /** Authentication is owned by the caller. This boundary must not accept untrusted identity claims. */
  subject: string;
  authorize(subject: string, setup: Setup): Promise<Observation>;
  inspectSecret(reference: SecretReference): Promise<Observation>;
}
export interface LaunchEvidence {
  schemaVersion: 1;
  revision: string;
  digest: string;
  subject: string;
  checkedAt: string;
  authorization: Observation;
  secrets: Array<{ reference: SecretReference; observation: Observation }>;
  allowed: boolean;
}
const unknown = (): Observation => ({ status: 'unknown', evidenceId: 'unavailable' });
async function observe(call: () => Promise<Observation>): Promise<Observation> {
  try {
    const value = await call();
    if (!['verified', 'denied', 'unknown'].includes(value.status) || !value.evidenceId) return unknown();
    return { status: value.status, evidenceId: value.evidenceId };
  } catch {
    // Provider exception bodies can contain credentials. Preserve uncertainty, not the raw body.
    return unknown();
  }
}
export async function checkSetup(input: unknown, context: CheckContext): Promise<LaunchEvidence> {
  const setup = parseSetup(input);
  const authorization = context.subject.trim()
    ? await observe(() => context.authorize(context.subject, parseSetup(setup))) : unknown();
  const secrets: LaunchEvidence['secrets'] = [];
  // Do not query provider metadata for an unauthorized caller.
  if (authorization.status === 'verified') {
    for (const reference of setup.secrets) {
      const observation = await observe(() => context.inspectSecret({ ...reference }));
      secrets.push({ reference: { ...reference }, observation });
    }
  } else {
    for (const reference of setup.secrets) secrets.push({ reference, observation: unknown() });
  }
  return {
    schemaVersion: 1, revision: setup.revision, digest: setupDigest(setup), subject: context.subject,
    checkedAt: new Date().toISOString(), authorization, secrets,
    allowed: authorization.status === 'verified' && secrets.every(s => s.observation.status === 'verified'),
  };
}
export class LaunchDenied extends Error {
  constructor(readonly evidence: LaunchEvidence) { super('Required launch checks did not pass'); }
}
/** Fresh checks and a detached input snapshot on every call; no caller-supplied approval record. */
export async function withLaunchChecks<T>(
  input: unknown, context: CheckContext, operation: (setup: Setup, evidence: LaunchEvidence) => Promise<T>,
): Promise<T> {
  const setup = parseSetup(input);
  const evidence = await checkSetup(setup, context);
  if (!evidence.allowed) throw new LaunchDenied(evidence);
  return operation(setup, evidence);
}
