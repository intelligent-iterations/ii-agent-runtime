import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorSupported, decorate, palette } from '../src/style.js';
import { createProgress } from '../src/progress.js';

const on = palette(true);
const esc = (text: string) => text.replace(/\x1b\[(\d+)m/g, (_, code: string) => `<${code}>`);

test('marks, links, details and question defaults get their colors', () => {
  assert.equal(esc(decorate('✓ Saved the key in example/hub (the only place it is stored)', on)), '<32>✓<39> Saved the key in example/hub<2> (the only place it is stored)<22>');
  assert.equal(esc(decorate('✗ Enter 1 or 2.', on)), '<31>✗ Enter 1 or 2.<39>');
  assert.equal(esc(decorate('! OPENAI_API_KEY is still stored', on)), '<33>! OPENAI_API_KEY is still stored<39>');
  assert.equal(esc(decorate('  · example/empty: skipped', on)), '  <2>· example/empty: skipped<22>');
  assert.equal(esc(decorate('? Use these limits? (Y/n) ', on)), '<36><1>?<22><39> <1>Use these limits?<22><2> (Y/n)<22> ');
  assert.equal(esc(decorate('? Agents running at once (1-10) [3]: ', on)), '<36><1>?<22><39> <1>Agents running at once (1-10)<22><2> [3]<22>: ');
  assert.equal(esc(decorate('  Ask for work: https://github.com/example/hub/issues/new', on)), '  Ask for work: <36><4>https://github.com/example/hub/issues/new<24><39>');
  assert.equal(esc(decorate('Agents:', on)), '<1>Agents:<22>');
});

test('plain text when color is off: NO_COLOR, a pipe, or a dumb terminal', () => {
  for (const line of ['✓ Saved (detail)', '? Use these limits? (Y/n) ', '  Ask for work: https://github.com/x']) assert.equal(decorate(line, palette(false)), line);
  assert.equal(colorSupported({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(colorSupported({ isTTY: false }, {}), false);
  assert.equal(colorSupported({ isTTY: true }, { TERM: 'dumb' }), false);
  assert.equal(colorSupported({ isTTY: true }, { TERM: 'xterm-256color' }), true);
  assert.equal(colorSupported({ isTTY: false }, { FORCE_COLOR: '1' }), true);
});

test('progress colors its spinner, counts and the slow-GitHub warning, and its result lines', () => {
  let clock = 0, output = '';
  const progress = createProgress({ write: (text: string) => { output += text; }, isTTY: true }, { now: () => clock, heartbeatMs: 1000000, quietMs: 10000, color: true });
  const task = progress.task('Checking repositories', 10);
  task.tick('example/one');
  clock += 11000; progress.line('x');
  task.done('10 repositories checked');
  const shown = esc(output);
  assert.match(shown, /<36>⠙<39> Checking repositories<2> · <22><2>1\/10<22><2> · <22><2>example\/one<22>/);
  assert.match(shown, /<33>still waiting on GitHub \(11s\)<39>/);
  assert.match(shown, /<32>✓<39> 10 repositories checked\n$/);
});
