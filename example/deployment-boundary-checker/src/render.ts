import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPreflightReport, terminalText as t } from '@intelligent-iterations/ii-agent-runtime/cli';
import type { BoundaryResult, InspectedWorkflows } from './check.js';

export interface RenderOptions {
  report?: boolean;
  /** Providers with a designated reader credential. Others are shown as "no credential designated". */
  designated?: readonly string[];
}
const answers: Record<BoundaryResult['answer'], string> = {
  yes: 'YES: a workflow job with deployment credentials runs a file this agent can write.',
  no: 'NO RECOGNIZED PATH: no inspected workflow runs or references anything this agent can write.',
  unknown: "CAN'T TELL: the evidence does not establish either answer.",
};
// The first limitation is the runtime's standing scope note; the rest explain this result.
const reasons = (result: BoundaryResult) => result.execution.limitations.slice(1);
/**
 * Runtime reasons that keep a result at can't tell, each with what it means. The runtime's decision is
 * unchanged; this only puts the deciding reason first. Other limitations describe identities or scope.
 */
const deciding: readonly [RegExp, string][] = [
  [/ is referenced by \S+\.$/, 'A workflow that mentions a file or its folder may read or run it, so a mention keeps the answer at can\'t tell, whatever that job\'s permissions.'],
  [/ may be run or loaded by repository code\.$/, 'Only documentation and static media (.md, .txt, images, ...) can be cleared; the check does not trace what repository code loads.'],
  [/ is a manifest or configuration file that tools run or load implicitly\.$/, 'Tools load this file implicitly, so it is never cleared. It is a finding only when a job with credentials runs a recognized npm, make, docker build or pip install step.'],
  [/ is a workflow or action definition\.$/, 'Workflow and action definitions decide what runs with credentials.'],
  [/^Some workflow syntax, reusable workflows or local actions are unsupported\.$/, 'The runtime does not name the job. Look for local actions (uses: ./...), reusable workflows, checkouts with ref, repository or path, working-directory, or YAML it cannot parse.'],
  [/^Repository evidence collection is incomplete\.$/, 'The workflows could not all be read; see the notes.'],
  [/^A path grant is not an exact string\.$/, ''],
];
const why = (result: BoundaryResult) => reasons(result).flatMap(reason => {
  const match = deciding.find(([pattern]) => pattern.test(reason));
  return match ? [{ reason, meaning: match[1] }] : [];
});
/**
 * Cloud identities on the path, each once: service accounts and roles the jobs assume, and long-lived keys they
 * read from secrets. Real repositories use the same identity from many jobs.
 */
const identities = (result: BoundaryResult) => [...new Set(result.execution.path.flatMap(step => {
  const assumed = /^assumes (\S+) (\S+)/.exec(step);
  if (assumed) return [`${assumed[1]} ${assumed[2]}`];
  const key = /^uses a long-lived (\S+) key from (\S+)/.exec(step);
  if (key) return [`${key[1]} key from ${key[2]}`];
  // Identities held in secrets or variables: name the reference, never guess the value.
  const unresolved = /^requests (\S+) credentials from (.+) \(unresolved\)$/.exec(step);
  if (!unresolved) return [];
  const root = /, which comes from (\S+)$/.exec(unresolved[2]!)?.[1];
  const references = root ? [root] : [...unresolved[2]!.matchAll(/\$\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g)].map(match => match[1]);
  return [`${unresolved[1]} unresolved (${references.length ? references.join(', ') : unresolved[2]})`];
}))];
/** Cloud actions on the path. Only GCP has a reader adapter here, so only GCP steps can appear. */
const authority = (result: BoundaryResult) => result.execution.path.filter(step => /^gcp:\S+ /.test(step));
/** Path steps shown in text output; --report and --json carry every step. */
const maxPathSteps = 12;
const shortName = (identity: string) => {
  const [, name = identity] = identity.split(' ');
  return identity.includes(' key from ') || identity.includes(' unresolved ') ? identity
    : name.split('/').at(-1)!.replace(/\.iam\.gserviceaccount\.com$/, '');
};
const identityNames = (result: BoundaryResult) => {
  const names = identities(result).map(shortName);
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
};
/** Marks unassessed identities whose provider has no designated reader credential. */
function pathSteps(result: BoundaryResult, designated: readonly string[]): string[] {
  let provider = '';
  return result.execution.path.map(step => {
    provider = /^assumes (\S+) /.exec(step)?.[1] ?? provider;
    return step === 'identity authority not assessed' && !designated.includes(provider)
      ? `${provider} authority not assessed (no credential designated)` : step;
  });
}
const writeStep = (step: string) => step.startsWith('contents.write ');
const jobStep = /^[^\s@]+@\S+:\.github\/workflows\/\S+#\S+$/;
/** The runtime's path is flat. Each job starts a group: the agent's files it runs (for a finding), the job, its identities. */
function groups(steps: readonly string[]): string[][] {
  const result: string[][] = [];
  steps.forEach((step, index) => {
    if (!result.length || (writeStep(step) || jobStep.test(step)) && !(index > 0 && writeStep(steps[index - 1]!))) result.push([]);
    result.at(-1)!.push(step);
  });
  return result;
}
function pathLines(result: BoundaryResult, designated: readonly string[]): string[] {
  const all = groups(pathSteps(result, designated));
  const total = all.flat().length;
  if (!total) return [];
  // Can't tell lists every job that holds credentials, not a path from the agent's files.
  const unknown = result.answer === 'unknown';
  const lines = unknown ? ["Jobs that hold credentials (this check did not link them to the agent's files):"] : [];
  let shown = 0;
  for (const [index, group] of all.entries()) {
    if (shown && shown + group.length > maxPathSteps) break;
    const visible = group.slice(0, maxPathSteps - shown);
    if (unknown) lines.push(...visible.map((step, line) => line ? `     ${t(step)}` : `  ${index + 1}. ${t(step)}`));
    else lines.push(all.length > 1 ? `Path ${index + 1}:` : 'Path:', ...visible.map((step, line) => `  ${line + 1}. ${t(step)}`));
    shown += visible.length;
  }
  if (total > shown) lines.push(`  ... ${total - shown} more steps (use --report or --json for all)`);
  return lines;
}
/** A local directory relative to the working directory when inside it; GitHub reads by repository and commit. */
function source(item: InspectedWorkflows): string {
  if (item.source.startsWith('file:')) {
    const path = fileURLToPath(item.source);
    const shown = relative(process.cwd(), path);
    return shown && !shown.startsWith('..') && !isAbsolute(shown) ? shown : path;
  }
  const commit = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/.exec(item.source)?.[1];
  return commit ? `GitHub ${item.repository}@${item.branch} at commit ${commit.slice(0, 12)}` : item.source;
}

export function renderResult(result: BoundaryResult, options: RenderOptions = {}): string {
  const deciding = why(result);
  const lines = [`Deployment boundary check | ${t(result.subject)}`,
    'Can this agent change anything that runs with deployment credentials?', `  ${answers[result.answer]}`];
  // Each explanation once, after the last reason it explains.
  if (result.answer === 'unknown') lines.push('Why:', ...(deciding.length
    ? deciding.flatMap(({ reason, meaning }, index) => [`  - ${t(reason)}`,
      ...(meaning && !deciding.slice(index + 1).some(item => item.meaning === meaning) ? [`    ${meaning}`] : [])])
    : ['  - The runtime reported no specific reason; see the notes below.']));
  lines.push('', 'Writable files:', ...result.writable.map(entry => `  ${t(entry)}`),
    ...(result.inspected.length ? result.inspected.map(item => `Inspected ${item.workflows.length} workflow file(s) from ${t(source(item))}.`)
      : ['Inspected no workflow files: they could not be read.']), '',
    `github.workflow-execution: ${result.execution.status.toUpperCase()}`, `  ${t(result.execution.summary)}`,
    ...pathLines(result, options.designated ?? []));
  if (identities(result).length) lines.push('Cloud identities these jobs use:', ...identities(result).map(identity => `  ${t(identity)}`));
  const notes = reasons(result).filter(reason => !deciding.some(item => item.reason === reason));
  if (notes.length) lines.push('Notes:', ...notes.map(item => `  - ${t(item)}`));
  lines.push(`Preflight admission: ${result.admission}`);
  if (options.report) lines.push('', '--- Full runtime preflight report ---', formatPreflightReport(result.report));
  return lines.join('\n');
}

/** Side-by-side summary, then each configuration's path. */
export function renderComparison(runs: readonly { label: string; result: BoundaryResult }[], options: RenderOptions = {}): string {
  const rows: [string, ...string[]][] = [
    ['', ...runs.map(run => run.label)],
    ['Writable files', ...runs.map(run => `${run.result.writable.length}`)],
    ['workflow-execution', ...runs.map(run => run.result.execution.status.toUpperCase())],
    ['Identities on reported path', ...runs.map(run => identityNames(run.result) || '-')],
    ['Cloud actions on reported path', ...runs.map(run => `${authority(run.result).length || '-'}`)],
    ['Preflight admission', ...runs.map(run => run.result.admission)],
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => t(row[column]!).length)));
  const lines = ['Deployment boundary comparison', '',
    ...rows.map(row => row.map((cell, column) => t(cell).padEnd(widths[column]! + 3)).join('').trimEnd())];
  // Otherwise a broad grant (finding) can show fewer identities than a narrow one (can't tell).
  if (runs.some(run => run.result.answer === 'unknown'))
    lines.push('', "Reported path: for a finding, the jobs that run the agent's files; for can't tell, every job that holds credentials.");
  for (const run of runs) lines.push('', `=== ${t(run.label)} ===`, renderResult(run.result, options));
  const statuses = runs.map(run => run.result.execution.status.toUpperCase());
  if (new Set(statuses).size > 1) lines.push('', `Narrowing the grants changed the result: ${statuses.join(' -> ')}.`);
  return lines.join('\n');
}
