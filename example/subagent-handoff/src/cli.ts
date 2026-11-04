import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeInvocations } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { exampleRoot, loadConfig, loadModelSettings } from './config.js';
import { demoCostLine, runDemo } from './demo.js';
import { liveModel, usageSummary, type LiveModelConfig, type LiveModelSession } from './model.js';
import { printExposure, printRun } from './report.js';
import { describeSystem, summarize } from './system.js';
import { workspaceTools } from './workspace.js';
import { projectName, runHandoff } from './workflow.js';

const HELP = `Subagent handoff: a read-only planner hands a fix to a narrowly scoped coder.

  npm run demo                                  both agents on the OpenAI API, on temporary copies of the bundled sample:
                                                a broad and a restricted coder. Needs OPENAI_API_KEY; at most $4 at the
                                                example rates. Model and prices come from config.example.json.
  npm run demo -- --config config.json          the same demo with the model and prices from your config
  npm start -- --config config.json --analyze   cross-agent analysis only; starts no agent and needs no key
  npm start -- --config config.json             run on your project (edits it in place); needs OPENAI_API_KEY
  npm run test:demo                             the same demo with its OpenAI calls answered by a test double; no key

  --broad   ignore coderWritablePaths and let the coder write every project file (for comparison)`;

const MISSING_KEY = 'OPENAI_API_KEY is not set. The demo runs both agents on the OpenAI API: create a key at ' +
  'https://platform.openai.com/api-keys, run export OPENAI_API_KEY=... in this terminal, then npm run demo again.';

/** Every agent run gets its own live gateway. Report what OpenAI said they used, also when a run stops early. */
async function withLiveModels<T>(settings: LiveModelConfig, signal: AbortSignal, run: (models: () => LiveModelSession) => Promise<T>) {
  const sessions: LiveModelSession[] = [];
  try { return await run(() => { const session = liveModel(settings, signal); sessions.push(session); return session; }); }
  finally { if (sessions.length) console.log(usageSummary(sessions, settings)); }
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, demo: { type: 'boolean' }, analyze: { type: 'boolean' },
    broad: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help || (!values.demo && !values.config)) { console.log(HELP); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (values.demo) {
      if (!process.env.OPENAI_API_KEY) { console.error(MISSING_KEY); process.exitCode = 1; return; }
      const settings = loadModelSettings(values.config ?? join(exampleRoot(), 'config.example.json'));
      console.log(demoCostLine(settings));
      const result = await withLiveModels(settings, controller.signal,
        models => runDemo({ model: settings.model, models, signal: controller.signal }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const config = loadConfig(values.config!, { live: !values.analyze, broad: values.broad === true });
    const { root, testScript, writable } = config;
    if (values.analyze) {
      const name = projectName(root);
      const tools = workspaceTools({ root, name, onHandoff: () => { throw Error('Analysis only'); } });
      const system = describeSystem(tools, { name, files: config.files, testScript, ...(writable ? { coderWritablePaths: writable } : {}) });
      console.log(`Project ${root}: ${config.files.length} file(s) visible to the agents (hidden, key, dependency and build files excluded).`);
      printExposure(console.log, summarize(analyzeInvocations(system.catalog)), Infinity);
      return;
    }
    liveModel(config, controller.signal); // validate key and rates before touching the project
    console.log(`Live run on ${root}. The coder edits files in place; use a clean Git working tree.`);
    const result = await withLiveModels(config, controller.signal, async models => {
      const result = await runHandoff({ root, task: config.task, testScript, model: config.model,
        signal: controller.signal, models, ...(writable ? { coderWritablePaths: writable } : {}) });
      printRun(console.log, result);
      return result;
    });
    if (result.after !== 0) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Subagent handoff failed'); process.exitCode = 1; });
