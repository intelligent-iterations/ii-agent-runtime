import assert from 'node:assert/strict';
import test from 'node:test';
import { commands, toolEnvironment } from '../src/deployment/commands.js';

test('command invocation preserves literal arguments without a shell', async () => {
  const literal = '$(exit 91); `exit 92`';
  const output = await commands.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], { cwd: process.cwd(), env: toolEnvironment(), timeoutMs: 5000 });
  assert.equal(output, literal);
});
test('nonzero exit, deadline and output overflow reject without revealing command output', async () => {
  const options = { cwd: process.cwd(), env: toolEnvironment(), timeoutMs: 500 };
  const scripts = [
    "process.stderr.write('synthetic-sensitive-value');process.exit(1)",
    'setInterval(()=>{},1000)',
    "process.stdout.write('x'.repeat(2*1024*1024))",
  ];
  for (const script of scripts) await assert.rejects(commands.run(process.execPath, ['-e', script], options), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /inspect operation state/);
    assert.ok(!error.message.includes('synthetic-sensitive-value')); return true;
  });
});
test('tool environment excludes unrelated launcher credentials and debug settings', () => {
  process.env.RUNTIME_TEST_SECRET = 'synthetic-value';
  try { assert.equal(toolEnvironment().RUNTIME_TEST_SECRET, undefined); assert.equal(toolEnvironment().TF_LOG, undefined); }
  finally { delete process.env.RUNTIME_TEST_SECRET; }
});

test('input handoff uses stdin rather than command arguments or environment', async () => {
  const output = await commands.run(process.execPath, ['-e', "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(String(s.length)))"],
    { cwd: process.cwd(), env: toolEnvironment(), timeoutMs: 5000, input: 'synthetic-sensitive-handoff' });
  assert.equal(output, '27');
});

test('completion removes background children even when their stdio is detached', async () => {
  const output = await commands.run(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);child.unref();
  `], { cwd: process.cwd(), env: toolEnvironment(), timeoutMs: 5000 });
  const pid = Number(output.trim()); assert.ok(pid > 0);
  const deadline = Date.now() + 3000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); break; }
    if (Date.now() > deadline) { process.kill(pid, 'SIGKILL'); assert.fail('Background child survived command completion'); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});
