import { createHash } from 'node:crypto';
import { canonicalJson } from './data.js';
import { ToolError, toolSnapshot, toolCredentialReferences, type ToolDefinition, type ToolGrant, type ToolSession } from './tools.js';

export interface PreflightEvidence {
  source: string;
  observedAt: number;
  /** Stable, non-secret resource reference; never raw credential contents. */
  resource: string;
}
export interface PreflightCheck {
  id: string;
  provider: string;
  status: 'finding' | 'clear' | 'unknown' | 'not-applicable';
  severity: 'info' | 'warning' | 'high';
  summary: string;
  tools: readonly string[];
  path: readonly string[];
  evidence: readonly PreflightEvidence[];
  limitations: readonly string[];
}
export interface PreflightInput {
  subject: string;
  tools: readonly ToolDefinition[];
  grants: readonly ToolGrant[];
  now: number;
  signal: AbortSignal;
}
/** Provider-owned knowledge and collection. The sandbox never supplies this adapter or its evidence. */
export interface PreflightInspector {
  provider: string;
  checks: readonly string[];
  inspect(input: PreflightInput): Promise<readonly PreflightCheck[]>;
}
export interface PreflightReport {
  configurationDigest: string;
  evaluatedAt: number;
  expiresAt: number;
  checks: readonly PreflightCheck[];
  coverage: 'partial' | 'supported-checks-complete';
  /** No report claims exhaustive provider or arbitrary-code analysis. */
  exhaustive: false;
}
export class PreflightAdmissionError extends ToolError {
  constructor(readonly report: PreflightReport, readonly failedChecks: readonly string[]) {
    super('PREFLIGHT_REQUIREMENT_UNMET');
  }
}
export const toolConfigurationDigest = (session: Pick<ToolSession, 'subject' | 'tools' | 'grants'>): string =>
  'sha256:' + createHash('sha256').update(canonicalJson({ subject: session.subject, tools: session.tools, grants: session.grants,
    credentials: toolCredentialReferences(session.tools) })).digest('hex');
const reports = new WeakSet<PreflightReport>();

/** Read-only assessment before launch. No key scope enumeration or escalation attempts. */
export async function preflightTools(session: ToolSession, options: {
  inspectors: readonly PreflightInspector[];
  signal: AbortSignal;
  maxAgeMs?: number;
  timeoutMs?: number;
}): Promise<PreflightReport> {
  const now = Date.now();
  const maxAge = options.maxAgeMs ?? 300000;
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 3600000 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000 ||
      !(options.signal instanceof AbortSignal) || options.signal.aborted) throw new ToolError('PREFLIGHT_INVALID_CONTEXT');
  const inspectors = new Map(options.inspectors.map(item => [item.provider, item]));
  if (inspectors.size !== options.inspectors.length) throw new ToolError('PREFLIGHT_DUPLICATE_PROVIDER');
  const checks: PreflightCheck[] = [];
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]);
  const input: PreflightInput = Object.freeze({ subject: session.subject, tools: session.tools, grants: session.grants, now, signal });
  for (const provider of new Set(session.tools.map(tool => tool.provider))) {
    const inspector = inspectors.get(provider);
    const unknown = (id: string, summary: string): PreflightCheck => ({ id, provider, status: 'unknown', severity: 'warning', summary,
      tools: session.tools.filter(tool => tool.provider === provider).map(tool => tool.name), path: [], evidence: [],
      limitations: ['No supported safety conclusion is available for this check.'] });
    if (!inspector) { checks.push(unknown(`${provider}.coverage`, 'No inspector configured for this provider')); continue; }
    if (!inspector.checks.length || new Set(inspector.checks).size !== inspector.checks.length ||
        inspector.checks.some(id => !id.startsWith(`${provider}.`))) throw new ToolError('PREFLIGHT_INVALID_INSPECTOR');
    let result: readonly PreflightCheck[];
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw Error('Interrupted');
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(Error('Interrupted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      result = toolSnapshot(await Promise.race([inspector.inspect(input), interrupted]));
      if (!Array.isArray(result) || result.some(check => !check || check.provider !== provider || !inspector.checks.includes(check.id)) ||
          new Set(result.map(check => check.id)).size !== result.length) throw Error('Invalid result');
    } catch {
      // Provider errors can contain credentials. Only fixed runtime messages are reported.
      result = [];
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    for (const id of inspector.checks) {
      const check = result.find(item => item.id === id);
      if (!check || !['finding', 'clear', 'unknown', 'not-applicable'].includes(check.status) ||
          !['info', 'warning', 'high'].includes(check.severity) || !Array.isArray(check.evidence) ||
          !Array.isArray(check.tools) || check.tools.some((name: string) => !input.tools.some(tool => tool.name === name && tool.provider === provider)) ||
          !Array.isArray(check.path) || !Array.isArray(check.limitations) || typeof check.summary !== 'string') {
        checks.push(unknown(id, 'Inspector did not return a valid result')); continue;
      }
      if (['clear', 'finding'].includes(check.status) && (!check.evidence.length || check.evidence.some((evidence: PreflightEvidence) =>
        typeof evidence.source !== 'string' || !evidence.source || typeof evidence.resource !== 'string' || !evidence.resource ||
        !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt > Date.now() || Date.now() - evidence.observedAt > maxAge))) {
        checks.push(unknown(id, 'Required evidence is missing, stale, or invalid')); continue;
      }
      checks.push(check);
    }
  }
  const observations = checks.flatMap(check => check.evidence.map(item => item.observedAt)).filter(Number.isSafeInteger);
  const report: PreflightReport = toolSnapshot({ configurationDigest: toolConfigurationDigest(session), evaluatedAt: Date.now(),
    expiresAt: Math.min(now + maxAge, ...observations.map(time => time + maxAge)), checks,
    coverage: checks.some(check => check.status === 'unknown') ? 'partial' : 'supported-checks-complete', exhaustive: false });
  reports.add(report);
  return report;
}

const admitted = new WeakMap<ToolSession, { digest: string; expiresAt: number }>();
/** Mandatory checks cannot be waived by severity. Advisory findings remain in the report. */
export function admitToolSession(session: ToolSession, report: PreflightReport,
  requiredChecks: readonly string[] = report.checks.map(check => check.id)): ToolSession {
  const digest = toolConfigurationDigest(session);
  if (!reports.has(report) || report.configurationDigest !== digest || !Number.isFinite(report.expiresAt) || report.expiresAt <= Date.now() ||
      report.evaluatedAt > Date.now()) throw new ToolError('PREFLIGHT_STALE_OR_CHANGED');
  const failed = requiredChecks.filter(id => {
    const check = report.checks.find(item => item.id === id);
    return !check || !['clear', 'not-applicable'].includes(check.status);
  });
  if (failed.length) throw new PreflightAdmissionError(report, Object.freeze(failed));
  admitted.set(session, { digest, expiresAt: report.expiresAt });
  return session;
}
/** Admission is checked immediately before opening the gateway, not inside the agent. */
export function assertToolSessionAdmitted(session: ToolSession): void {
  const receipt = admitted.get(session);
  if (!receipt || receipt.expiresAt <= Date.now() || receipt.digest !== toolConfigurationDigest(session)) throw new ToolError('PREFLIGHT_REQUIRED');
}
