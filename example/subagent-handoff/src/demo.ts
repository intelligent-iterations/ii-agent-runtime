import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TASK } from './config.js';
import { agentCostCeilingMicrousd, dollars, MODEL_LIMITS, type LiveModelConfig, type ModelSession } from './model.js';
import { printRun, type Print } from './report.js';
import { runHandoff, type HandoffResult } from './workflow.js';

/** The two setups the demo compares, on fresh copies of the bundled sample. */
export const DEMO_SETUPS = [
  { label: 'Broad setup: the coder may write every project file' },
  { label: 'Restricted setup: the coder may write only src/ files', coderWritablePaths: ['src/cart.js', 'src/currency.js'], probe: true },
] as const;
export const DEMO_AGENT_RUNS = DEMO_SETUPS.length * 2;

/** The most one demo run can reserve: every agent run (planner and coder, per setup) has its own gateway limit. */
export function demoCostLine(settings: LiveModelConfig): string {
  const perAgent = agentCostCeilingMicrousd(settings);
  return `OpenAI model ${settings.model} at ${dollars(settings.inputMicrousdPerMillionTokens)} input / ` +
    `${dollars(settings.outputMicrousdPerMillionTokens)} output per 1M tokens. Each of the ${DEMO_AGENT_RUNS} agent runs is limited to ` +
    `${MODEL_LIMITS.maxModelRequests} requests and ${dollars(perAgent)}, so this demo costs at most ${dollars(perAgent * DEMO_AGENT_RUNS)}.`;
}

export interface DemoOptions {
  /** The model ID the agents send. */
  model: string;
  /**
   * One model session per agent run ("planner" or "coder"). `npm run demo` passes the runtime's OpenAI adapter;
   * `npm run test:demo` passes the same adapter with its calls to OpenAI intercepted.
   */
  models(subject: string): ModelSession;
  signal: AbortSignal;
  print?: Print;
}

export interface DemoCheck { ok: boolean; text: string }

/**
 * Run the planner-to-coder handoff on temporary copies of the bundled sample, broad then restricted, and check
 * the outcomes. Model output varies, so the checks are about results, not text.
 */
export async function runDemo(options: DemoOptions) {
  const print = options.print ?? console.log;
  const sample = fileURLToPath(new URL('../sample/', import.meta.url));
  const results: HandoffResult[] = [];
  for (const setup of DEMO_SETUPS) {
    const root = mkdtempSync(join(tmpdir(), 'subagent-handoff-'));
    try {
      cpSync(sample, root, { recursive: true });
      print(`\n== ${setup.label} ==`);
      const result = await runHandoff({ root, task: DEFAULT_TASK, testScript: 'test', model: options.model, models: options.models,
        signal: options.signal, ...('coderWritablePaths' in setup ? { coderWritablePaths: setup.coderWritablePaths, probe: setup.probe } : {}) });
      printRun(print, result);
      results.push(result);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const [broad, restricted] = results as [HandoffResult, HandoffResult];
  const reach = { broad: broad.exposure.reachableWrites.length, restricted: restricted.exposure.reachableWrites.length };
  const denied = restricted.probes.filter(probe => probe.status === 403 && probe.unchanged).length;
  const checks: DemoCheck[] = [
    { ok: results.every(result => result.before === 1 && result.after === 0),
      text: `Test script exit before -> after: broad ${broad.before} -> ${broad.after}, restricted ${restricted.before} -> ${restricted.after} (expected 1 -> 0)` +
        (results.some(result => result.before === 0) ? '. The bundled sample already passes: restore sample/ (for example git checkout -- sample) and run the demo again' : '') },
    { ok: restricted.probes.length > 0 && denied === restricted.probes.length,
      text: restricted.probes.length
        ? `Writes outside the restricted coder's grant: ${denied} of ${restricted.probes.length} denied with HTTP 403, files unchanged`
        : 'Writes outside the restricted coder\'s grant: not tried, because the restricted coder never started' },
    { ok: reach.restricted < reach.broad,
      text: `Files the planner can indirectly get written: ${reach.broad} broad, ${reach.restricted} restricted (expected fewer when restricted)` },
  ];
  print('\nDemo checks (model output varies; these outcomes must hold):');
  for (const check of checks) print(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.text}`);
  const ok = checks.every(check => check.ok);
  print(ok
    ? `\nRestricting the coder cut the files the planner can indirectly get written from ${reach.broad} to ${reach.restricted}. ` +
      `The handoff still fixed the test (exit ${restricted.after}).`
    : `\nDemo failed: ${checks.filter(check => !check.ok).length} of ${checks.length} checks did not pass (see FAIL above).`);
  return { broad, restricted, checks, ok };
}
