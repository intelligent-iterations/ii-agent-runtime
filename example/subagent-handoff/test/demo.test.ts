// npm run test:demo: the demo without a key. It runs the same runDemo call as `npm run demo`, with the runtime's
// OpenAI adapter and limits, and intercepts only the adapter's calls to api.openai.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exampleRoot, loadModelSettings } from '../src/config.js';
import { demoCostLine, runDemo } from '../src/demo.js';
import { liveModel, usageSummary, type LiveModelSession, type ModelSession } from '../src/model.js';
import { CODER } from '../src/system.js';
import { interceptOpenAI, scriptedCoder, scriptedModel, scriptedPlanner, type InterceptedCall } from './scripted-model.js';

const NAME = 'sample-cart';
const settings = loadModelSettings(join(exampleRoot(), 'config.example.json'));
const TEST_KEY = 'sk-test-intercepted';

async function interceptedDemo(coder: (model: string) => ModelSession = model => scriptedCoder(NAME, 'test', model)) {
  const lines: string[] = [], calls: InterceptedCall[] = [], sessions: LiveModelSession[] = [];
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = TEST_KEY;
  try {
    const signal = new AbortController().signal;
    const result = await runDemo({ model: settings.model, signal, print: line => lines.push(line), models: subject => {
      const scripted = subject === CODER ? coder(settings.model) : scriptedPlanner(NAME, 'test', settings.model);
      const session = liveModel(settings, signal, { fetch: interceptOpenAI(scripted, calls) });
      sessions.push(session);
      return session;
    } });
    return { result, lines, calls, sessions, output: lines.join('\n') };
  } finally { if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; }
}

test('npm run demo with its OpenAI calls intercepted: the same comparison, the same checks', async () => {
  const { result, lines, calls, sessions, output } = await interceptedDemo();
  assert.equal(result.ok, true, output);
  assert.deepEqual(result.checks.map(check => check.ok), [true, true, true]);
  for (const setup of [result.broad, result.restricted]) {
    assert.equal(setup.before, 1);
    assert.equal(setup.after, 0);
    assert.deepEqual(setup.handoff!.grantedFiles, ['src/cart.js']);
  }
  assert.equal(result.broad.exposure.reachableWrites.length, 4);
  assert.equal(result.restricted.exposure.reachableWrites.length, 2);
  assert.deepEqual(result.broad.probes, []);
  assert.deepEqual(result.restricted.probes, [
    { path: 'package.json', status: 403, unchanged: true },
    { path: 'src/currency.js', status: 403, unchanged: true },
    { path: 'test/cart.test.js', status: 403, unchanged: true },
  ]);
  // What the demo prints: both setups, the three checks and the headline.
  assert.ok(lines.includes('\n== Broad setup: the coder may write every project file =='));
  assert.ok(lines.includes('\n== Restricted setup: the coder may write only src/ files =='));
  assert.deepEqual(lines.filter(line => /^ {2}(PASS|FAIL) /.test(line)).map(line => line.slice(2, 6)), ['PASS', 'PASS', 'PASS']);
  assert.match(output, /PASS Writes outside the restricted coder's grant: 3 of 3 denied with HTTP 403, files unchanged/);
  assert.equal(lines.at(-1), '\nRestricting the coder cut the files the planner can indirectly get written from 4 to 2. The handoff still fixed the test (exit 0).');
  // Every model request went through the runtime adapter to OpenAI's two endpoints, with the host's key.
  assert.equal(sessions.length, 4);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api\.openai\.com\/v1\/responses(\/input_tokens)?$/);
    assert.equal(call.authorization, `Bearer ${TEST_KEY}`);
  }
  const generations = calls.filter(call => call.url.endsWith('/responses')).length;
  assert.match(usageSummary(sessions, settings), new RegExp(`^Model use reported by OpenAI: ${generations} request\\(s\\) from 4 agent run\\(s\\), .*reserved \\$0\\.\\d+\\.$`));
});

test('the demo fails, and says which outcome did not hold, when the handoff does not fix the test', async () => {
  const idle = (model: string) => scriptedModel((_request, turn) => [{ type: 'message', id: `msg_${turn}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'I changed nothing.', annotations: [] }] }], model);
  const { result, lines, output } = await interceptedDemo(idle);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map(check => check.ok), [false, true, true]);
  assert.match(output, /FAIL Test script exit before -> after: broad 1 -> 1, restricted 1 -> 1 \(expected 1 -> 0\)/);
  assert.equal(lines.at(-1), '\nDemo failed: 1 of 3 checks did not pass (see FAIL above).');
});

test('one demo run costs at most $4 at the example rates: 4 agent runs, each limited to 16 requests and $1', () => {
  assert.deepEqual(settings, { model: 'gpt-5.6-terra', inputMicrousdPerMillionTokens: 2_000_000, outputMicrousdPerMillionTokens: 12_000_000 });
  assert.equal(demoCostLine(settings), 'OpenAI model gpt-5.6-terra at $2.00 input / $12.00 output per 1M tokens. ' +
    'Each of the 4 agent runs is limited to 16 requests and $1.00, so this demo costs at most $4.00.');
  // At lower rates, 16 worst-case requests (64,000 input and 4,000 output tokens each) cost less than the $1 cap.
  assert.match(demoCostLine({ model: 'cheap', inputMicrousdPerMillionTokens: 100_000, outputMicrousdPerMillionTokens: 400_000 }),
    /limited to 16 requests and \$0\.13, so this demo costs at most \$0\.51\.$/);
});

test('npm run demo without OPENAI_API_KEY prints one line naming it and how to set it, and exits 1', async () => {
  const source = import.meta.url.endsWith('.ts');
  const cli = fileURLToPath(new URL(source ? '../src/cli.ts' : '../src/cli.js', import.meta.url));
  const failure = await promisify(execFile)(process.execPath, [...(source ? ['--import', 'tsx'] : []), cli, '--demo'],
    { cwd: exampleRoot(), env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 }).then(() => undefined, (error: unknown) => error);
  const { code, stdout, stderr } = failure as { code: number; stdout: string; stderr: string };
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'OPENAI_API_KEY is not set. The demo runs both agents on the OpenAI API: create a key at ' +
    'https://platform.openai.com/api-keys, run export OPENAI_API_KEY=... in this terminal, then npm run demo again.\n');
});
