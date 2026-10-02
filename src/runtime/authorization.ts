import { canonicalJson, digest } from './configuration.js';

export type InvocationPolicy =
  | { mode: 'authorized-author'; requiredCapability: string }
  | { mode: 'maintainer-approval'; requiredCapability: string; label: string }
  | { mode: 'any-author'; allowPublicContributors: true };

/** Facts supplied by a trusted provider adapter, never deserialized from task text. */
export interface InvocationEvidence {
  resource: string;
  event: 'submitted' | 'approved';
  subjectId: string;
  authorId: string;
  actorId: string;
  actorCapabilities: string[];
  rerun?: { actorId: string; capabilities: string[] };
  label?: string;
  currentLabels: string[];
  originalInputDigest: string;
  currentInputDigest: string;
  policyDigest: string;
  currentPolicyDigest: string;
  observedAt: number;
  open: boolean;
  runId: string;
  attempt: number;
}
export interface InvocationDecision {
  allowed: boolean;
  reason: string;
  evidenceDigest: string;
  policyDigest: string;
  runId: string;
  subjectId: string;
}

/** Fail closed on stale, mismatched or incomplete evidence. Does not perform provider I/O. */
export function authorizeInvocation(policy: InvocationPolicy, target: string, evidence: InvocationEvidence, now: number): InvocationDecision {
  const deny = (reason: string): InvocationDecision => ({ allowed: false, reason,
    evidenceDigest: digest(canonicalJson(evidence)), policyDigest: evidence.currentPolicyDigest,
    runId: evidence.runId, subjectId: evidence.subjectId });
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(evidence.observedAt) || now < evidence.observedAt || now - evidence.observedAt > 60_000) return deny('evidence-stale');
  if (!evidence.actorId || !evidence.authorId || !evidence.subjectId || !evidence.runId || !Number.isSafeInteger(evidence.attempt) || evidence.attempt < 1) return deny('identity-missing');
  if (evidence.resource !== target) return deny('resource-mismatch');
  if (!evidence.open) return deny('subject-closed');
  if (!/^sha256:[a-f0-9]{64}$/.test(evidence.policyDigest) || evidence.policyDigest !== evidence.currentPolicyDigest) return deny('policy-changed');
  if (!/^sha256:[a-f0-9]{64}$/.test(evidence.originalInputDigest) || evidence.originalInputDigest !== evidence.currentInputDigest) return deny('input-changed');
  if (evidence.attempt > 1) {
    if (!evidence.rerun?.actorId || !evidence.rerun.capabilities.includes('invocation:rerun')) return deny('rerun-denied');
  } else if (evidence.rerun) return deny('unexpected-rerun');
  switch (policy.mode) {
    case 'authorized-author':
      if (!policy.requiredCapability || evidence.event !== 'submitted' || evidence.actorId !== evidence.authorId) return deny('author-event-required');
      if (!evidence.actorCapabilities.includes(policy.requiredCapability)) return deny('author-denied');
      break;
    case 'maintainer-approval':
      if (!policy.requiredCapability || !policy.label || evidence.event !== 'approved' || evidence.label !== policy.label || !evidence.currentLabels.includes(policy.label)) return deny('approval-required');
      if (!evidence.actorCapabilities.includes(policy.requiredCapability)) return deny('approver-denied');
      break;
    case 'any-author':
      if (policy.allowPublicContributors !== true || evidence.event !== 'submitted' || evidence.actorId !== evidence.authorId) return deny('public-submission-required');
      break;
    default: return deny('unknown-policy');
  }
  return { ...deny('authorized'), allowed: true };
}
