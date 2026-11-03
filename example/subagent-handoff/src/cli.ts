import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeInvocations } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { liveModel, scriptedCoder, scriptedPlanner } from './model.js';
import { DEFAULT_TASK, loadConfig } from './config.js';
import { CODER, describeSystem, summarize } from './system.js';
import { HANDOFF_EVENT, workspaceTools } from './workspace.js';
import { projectName, runHandoff, type AgentStep, type HandoffResult } from './workflow.js';

const HELP = `Subagent handoff: a read-only planner hands a fix to a narrowly scoped coder.

  npm run demo                                  scripted agents on temporary copies of the bundled sample (no model key)
  npm start -- --config config.json --analyze   cross-agent analysis only; starts no agent
  npm start -- --config config.json             live run on your project; needs OPENAI_API_KEY on this host

  --broad   ignore coderWritablePaths and let the coder write every project file (for comparison)`;

let listLimit = 6;
const list = (values: readonly string[]) => values.length > listLimit ? `${values.slice(0, listLimit).join(', ')}, ... (${values.length - listLimit} more; --analyze lists all)` : values.join(', ') || 'none';
function printExposure(exposure: ReturnType<typeof summarize>) {
  console.log('Cross-agent analysis (runtime analyzeInvocations; based on declarations, not exhaustive):');
  console.log(`  ! ${exposure.message ?? 'No declared path from the planner to the coder.'}`);
  console.log(`  Planner's own write grants: ${exposure.directWrites}`);
  console.log(`  Reachable through the coder: write-file on ${exposure.reachableWrites.length} file(s) [${list(exposure.reachableWrites)}]; run-script [${list(exposure.reachableScripts)}]`);
  for (const note of exposure.notes) console.log(`  Note: ${note}`);
}
const step = (item: AgentStep) => `    ${item.tool} ${item.target} → HTTP ${item.status}${item.exitCode === undefined ? '' : `, exit ${item.exitCode}`}`;
function printRun(result: HandoffResult) {
  printExposure(result.exposure);
  console.log(`Provider preflight: ${result.preflight} coverage (no escalation inspector exists for local workspace tools); gateway grants are enforced.`);
  console.log('Planner (read-only):');
  result.planner.steps.forEach(item => console.log(step(item)));
  if (!result.handoff) { console.log('No handoff was made.'); return; }
  console.log(`Handoff: ${HANDOFF_EVENT} → ${result.handoff.routedTo.join(', ') || 'no matching invoker'}; files [${list(result.handoff.grantedFiles)}]` +
    (result.handoff.refusedFiles.length ? `; refused outside the coder's bound [${list(result.handoff.refusedFiles)}]` : ''));
  if (result.coder) {
    console.log(`Coder (write-file narrowed to [${list(result.handoff.grantedFiles)}] of ${result.writable.length} configured):`);
    result.coder.steps.forEach(item => console.log(step(item)));
  }
  if (result.probes.length) console.log('Gateway check with the coder\'s token:');
  for (const probe of result.probes) console.log(`    write-file ${probe.path} → HTTP ${probe.status}${probe.unchanged ? ' (file unchanged)' : ' (FILE CHANGED)'}`);
  console.log(`Test script: exit ${result.before} before, exit ${result.after} after.`);
}

async function demo(signal: AbortSignal) {
  const sample = fileURLToPath(new URL('../sample/', import.meta.url));
  const setups = [
    { label: 'Broad setup: the coder may write every project file', probe: [] as string[] },
    { label: 'Restricted setup: the coder may write only src/ files', writable: ['src/cart.js', 'src/currency.js'],
      probe: ['test/cart.test.js', 'package.json', 'src/currency.js'] },
  ];
  const results: HandoffResult[] = [];
  for (const setup of setups) {
    const root = mkdtempSync(join(tmpdir(), 'subagent-handoff-'));
    try {
      cpSync(sample, root, { recursive: true });
      console.log(`\n== ${setup.label} ==`);
      const result = await runHandoff({ root, task: DEFAULT_TASK, testScript: 'test', model: 'scripted', signal, probe: setup.probe,
        ...(setup.writable ? { coderWritablePaths: setup.writable } : {}),
        models: subject => subject === CODER ? scriptedCoder('sample-cart', 'test') : scriptedPlanner('sample-cart', 'test') });
      printRun(result);
      results.push(result);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const [broad, restricted] = results;
  console.log(`\nRestricting the coder cut the files the planner can indirectly get written from ${broad!.exposure.reachableWrites.length} to ` +
    `${restricted!.exposure.reachableWrites.length}. The handoff still fixed the test (exit ${restricted!.after}).`);
  if (results.some(result => result.after !== 0)) process.exitCode = 1;
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, demo: { type: 'boolean' }, analyze: { type: 'boolean' },
    broad: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help || (!values.demo && !values.config)) { console.log(HELP); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (values.demo) { await demo(controller.signal); return; }
    const config = loadConfig(values.config!, { live: !values.analyze, broad: values.broad === true });
    const { root, testScript, writable } = config;
    if (values.analyze) {
      listLimit = Infinity;
      const name = projectName(root);
      const tools = workspaceTools({ root, name, onHandoff: () => { throw Error('Analysis only'); } });
      const system = describeSystem(tools, { name, files: config.files, testScript, ...(writable ? { coderWritablePaths: writable } : {}) });
      console.log(`Project ${root}: ${config.files.length} file(s) visible to the agents (hidden, key, dependency and build files excluded).`);
      printExposure(summarize(analyzeInvocations(system.catalog)));
      return;
    }
    liveModel(config, controller.signal); // validate key and rates before touching the project
    console.log(`Live run on ${root}. The coder edits files in place; use a clean Git working tree.`);
    const result = await runHandoff({ root, task: config.task, testScript, model: config.model,
      signal: controller.signal, models: () => liveModel(config, controller.signal), ...(writable ? { coderWritablePaths: writable } : {}) });
    printRun(result);
    console.log(`\nPlanner: ${result.planner.text}\nCoder: ${result.coder?.text ?? '(not started)'}`);
    if (result.after !== 0) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Subagent handoff failed'); process.exitCode = 1; });
