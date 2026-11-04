import type { summarize } from './system.js';
import { HANDOFF_EVENT } from './workspace.js';
import type { AgentStep, HandoffResult } from './workflow.js';

export type Print = (line: string) => void;

const list = (values: readonly string[], limit: number) => values.length > limit
  ? `${values.slice(0, limit).join(', ')}, ... (${values.length - limit} more; --analyze lists all)` : values.join(', ') || 'none';

export function printExposure(print: Print, exposure: ReturnType<typeof summarize>, limit = 6) {
  print('Cross-agent analysis (runtime analyzeInvocations; based on declarations, not exhaustive):');
  print(`  ! ${exposure.message ?? 'No declared path from the planner to the coder.'}`);
  print(`  Planner's own write grants: ${exposure.directWrites}`);
  print(`  Reachable through the coder: write-file on ${exposure.reachableWrites.length} file(s) [${list(exposure.reachableWrites, limit)}]; ` +
    `run-script [${list(exposure.reachableScripts, limit)}]`);
  for (const note of exposure.notes) print(`  Note: ${note}`);
}

const step = (item: AgentStep) => `    ${item.tool} ${item.target} -> HTTP ${item.status}${item.exitCode === undefined ? '' : `, exit ${item.exitCode}`}`;
const reply = (text: string | undefined) => (text?.trim() || '(no text)').split('\n').join('\n    ');

export function printRun(print: Print, result: HandoffResult, limit = 6) {
  printExposure(print, result.exposure, limit);
  print(`Provider preflight: ${result.preflight} coverage (no escalation inspector exists for local workspace tools); gateway grants are enforced.`);
  print('Planner (read-only):');
  result.planner.steps.forEach(item => print(step(item)));
  if (result.handoff) {
    print(`Handoff: ${HANDOFF_EVENT} -> ${result.handoff.routedTo.join(', ') || 'no matching invoker'}; files [${list(result.handoff.grantedFiles, limit)}]` +
      (result.handoff.refusedFiles.length ? `; refused outside the coder's bound [${list(result.handoff.refusedFiles, limit)}]` : ''));
    if (result.coder) {
      print(`Coder (write-file narrowed to [${list(result.handoff.grantedFiles, limit)}] of ${result.writable.length} configured):`);
      result.coder.steps.forEach(item => print(step(item)));
    }
  } else print('No handoff was made.');
  if (result.probes.length) print('Gateway check with the coder\'s token:');
  for (const probe of result.probes) print(`    write-file ${probe.path} -> HTTP ${probe.status}${probe.unchanged ? ' (file unchanged)' : ' (FILE CHANGED)'}`);
  print(`Test script: exit ${result.before} before, exit ${result.after} after.`);
  print(`Planner's reply: ${reply(result.planner.text)}`);
  if (result.coder) print(`Coder's reply: ${reply(result.coder.text)}`);
}
