import type { PreflightReport } from '../runtime/preflight.js';

/** Escape untrusted terminal controls without altering the underlying report. */
export function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Presentation only. Admission remains the runtime's responsibility. */
export function formatPreflightReport(report: PreflightReport): string {
  const count = (status: string) => report.checks.filter(check => check.status === status).length;
  const findings = count('finding');
  const unknown = count('unknown');
  const outcome = findings ? 'FINDINGS REQUIRE REVIEW' : unknown || report.coverage === 'partial'
    ? 'ASSESSMENT INCOMPLETE' : 'NO FINDINGS IN SUPPORTED CHECKS';
  const timestamp = (value: number) => new Date(value).toISOString();
  const lines = ['II Agent Runtime | Permission preflight', '', outcome,
    `${findings} ${findings === 1 ? 'finding' : 'findings'} | ${unknown} unknown | ${count('clear')} clear | ${count('not-applicable')} not applicable`,
    `Coverage: ${report.coverage}`, `Configuration: ${terminalText(report.configurationDigest)}`,
    `Evaluated: ${timestamp(report.evaluatedAt)}`, `Expires: ${timestamp(report.expiresAt)}`];
  for (const status of ['finding', 'unknown', 'clear', 'not-applicable']) {
    for (const check of report.checks.filter(item => item.status === status)) {
      lines.push('', `${check.status.toUpperCase()} / ${check.severity.toUpperCase()}  ${terminalText(check.id)}`,
        `  ${terminalText(check.summary)}`, `  Provider: ${terminalText(check.provider)}`);
      if (check.tools.length) lines.push(`  Tools: ${check.tools.map(terminalText).join(', ')}`);
      if (check.path.length) {
        lines.push('  Path:');
        check.path.forEach((step, index) => lines.push(`    ${index + 1}. ${terminalText(step)}`));
      }
      for (const evidence of check.evidence) lines.push(`  Evidence: ${terminalText(evidence.resource)}`,
        `    Source: ${terminalText(evidence.source)} | observed ${timestamp(evidence.observedAt)}`);
      for (const limitation of check.limitations) lines.push(`  Limit: ${terminalText(limitation)}`);
    }
  }
  lines.push('', 'Known-pattern assessment only. This report does not grant admission or establish that the environment is secure.');
  return lines.join('\n');
}
