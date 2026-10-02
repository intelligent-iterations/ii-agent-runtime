import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLimits, editLimits, LimitError } from '../src/limits-editor.js';
import { validateHubManifest } from '../src/hub-files.js';
import { compileHubPolicy, hubPolicy } from '../src/hub-policy.js';
import { samplePolicy } from './policy-fixture.js';
import { CURRENT_LAYOUT } from '../src/identity.js';

const manifest = validateHubManifest({ schemaVersion: 2, kind: 'software-factory-hub', organization: 'example',
  hub: { repository: 'example/software-factory', id: 5, branch: 'main' }, app: { id: 10, installationId: 20 } }, CURRENT_LAYOUT);
function scripted(answers: string[]) {
  const asked: string[] = [], reported: string[] = [];
  return { asked, reported, ask: async (question: string) => { asked.push(question); if (!answers.length) throw Error(`No answer left for ${question}`); return answers.shift()!; },
    report: (message: string) => { reported.push(message); } };
}
const defaults = () => JSON.parse(hubPolicy(samplePolicy()));

test('Enter keeps every current value and shows it in brackets', async () => {
  const run = scripted(['', '', '', '', '', '', '', '']);
  const policy = await editLimits(defaults(), run.ask, run.report);
  assert.deepEqual(policy, defaults());
  assert.deepEqual(run.asked, [
    '? Who starts an agent? 1 = the issue author, 2 = someone who adds a label [1]: ',
    '? Access to the named repository needed to start (write, maintain or admin) [write]: ',
    '? Agents running at once, across the organization (1-10) [3]: ',
    '? Agent runs per issue (1-10) [1]: ',
    '? Agent runs per month, across the organization (1-1000) [20]: ',
    '? Minutes one run may take (1-55) [15]: ',
    '? Model budget per run (USD) [10.00]: ',
    '? Total budget per month, across the organization (USD) [250.00]: ',
  ]);
});

test('answers change the policy, bad answers are asked again, and label approval asks for its label', async () => {
  const run = scripted(['3', '2', 'bug', 'agent:go', 'read', 'maintain', '0', '5', '2', '100', '30', '$2.50', 'lots', '$75']);
  const policy = await editLimits(defaults(), run.ask, run.report);
  assert.deepEqual(policy.launchPolicy, { mode: 'maintainer-approval', minimumPermission: 'maintain', label: 'agent:go' });
  assert.deepEqual([policy.limits.maxConcurrent, policy.limits.maxRunsPerIssue, policy.limits.maxRunsPerMonth, policy.limits.timeoutMinutes,
    policy.limits.maxModelCostMicrousdPerRun, policy.limits.maxCostMicrousdPerMonth], [5, 2, 100, 30, 2500000, 75000000]);
  assert.deepEqual(run.reported, ['✗ Enter 1 or 2.', '✗ The label must start with "agent" and use letters, numbers, ":", ".", "_" or "-" (up to 50 characters).',
    '✗ Enter write, maintain or admin.', '✗ Enter a whole number of agents from 1 to 10.', '✗ Enter the monthly budget in US dollars, for example 20 or 7.50.']);
  assert.ok(run.asked.some(question => question.includes('needed to approve')));
  compileHubPolicy(JSON.stringify(policy), manifest, 'example/sample-project');
});

test('limits where one run costs more than the whole month are refused and asked again', async () => {
  // A $300 per-run model budget with a $250 monthly budget would refuse every run.
  const run = scripted(['', '', '', '', '', '', '300', '', '', '', '', '', '', '', '', '400']);
  const policy = await editLimits(defaults(), run.ask, run.report);
  assert.match(run.reported[0]!, /One run reserves up to \$300\.12 .* more than the monthly budget of \$250\.00, so every run would be refused/);
  assert.equal(run.asked.filter(question => question.startsWith('? Who starts')).length, 2, 'the questions start again with the answers kept');
  assert.deepEqual([policy.limits.maxModelCostMicrousdPerRun, policy.limits.maxCostMicrousdPerMonth], [300000000, 400000000]);
  assert.throws(() => checkLimits({ limits: { ...defaults().limits, maxCostMicrousdPerMonth: 1000000 } }), LimitError);
});

test('the default agent is gpt-6-astra at its published price, and its budgets fit a maximum-size request and a month of runs', () => {
  const policy = defaults();
  assert.deepEqual([policy.harness.model, policy.limits.inputMicrousdPerMillionTokens, policy.limits.outputMicrousdPerMillionTokens], ['gpt-6-astra', 10000000, 50000000]);
  const largest = (policy.limits.maxInputTokensPerRequest * policy.limits.inputMicrousdPerMillionTokens + policy.limits.maxOutputTokensPerRequest * policy.limits.outputMicrousdPerMillionTokens) / 1e6;
  assert.ok(largest < policy.limits.maxModelCostMicrousdPerRun, `one maximum-size request (${largest} microdollars) fits the per-run budget`);
  checkLimits(policy);
  assert.match(policy._readme, /To change the model, set harness.model/);
  assert.equal(compileHubPolicy(JSON.stringify(policy), manifest, 'example/sample-project').configuration.harness.model, 'gpt-6-astra', 'notes are removed before compiling');
});

test('an organization defaults file beside the connection record is used, for example a cheaper model with a small cap', async t => {
  const { mkdtempSync, rmSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { organizationDefaults } = await import('../src/init-command.js');
  const { parseConfigurationFile } = await import('@intelligent-iterations/ii-agent-runtime/runtime');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-org-defaults-')));
  t.after(() => rmSync(root, { recursive: true }));
  assert.equal(organizationDefaults(root), undefined);
  const luna = structuredClone(samplePolicy()) as any;
  luna.harness.model = 'gpt-6-luna';
  Object.assign(luna.limits, { inputMicrousdPerMillionTokens: 100000, outputMicrousdPerMillionTokens: 500000, maxModelCostMicrousdPerRun: 250000, maxCostMicrousdPerMonth: 5000000 });
  writeFileSync(join(root, 'runtime.json'), JSON.stringify(luna));
  assert.equal(organizationDefaults(root), join(root, 'runtime.json'));
  const policy = JSON.parse(hubPolicy(parseConfigurationFile(join(root, 'runtime.json')) as Record<string, unknown>));
  checkLimits(policy);
  assert.equal(compileHubPolicy(JSON.stringify(policy), manifest, 'example/sample-project').configuration.limits.maxCostMicrousdPerMonth, 5000000);
});
