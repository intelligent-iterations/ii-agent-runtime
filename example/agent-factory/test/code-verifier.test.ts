import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { runCodeVerification, type CodeVerificationInput } from '../src/code-verifier.js';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(links = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-verifier-'))); const workspace = join(root, 'source'); mkdirSync(workspace);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  const git = async (...args: string[]) => (await promisify(execFile)('/usr/bin/git', args, { cwd: workspace, env })).stdout.trim();
  await git('init'); writeFileSync(join(workspace, 'answer.txt'), 'wrong'); await git('add', '.'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD'); const baseBundle = join(root, 'base.bundle'); await git('bundle', 'create', baseBundle, 'HEAD');
  writeFileSync(join(workspace, 'answer.txt'), 'correct');
  if (links) { symlinkSync('answer.txt',join(workspace,'AGENTS.md')); mkdirSync(join(workspace,'docs')); symlinkSync('../AGENTS.md',join(workspace,'docs','instructions')); }
  const candidate = await sealCodeCandidate({ workspace, directory: join(root, 'sealed'), baseCommit, secretValues: [] });
  const input: CodeVerificationInput = { executionId: 'task', attemptId: 'verification', candidate,
    baseBundle: { path: baseBundle, sha256: hash(readFileSync(baseBundle)) }, candidateBundlePath: join(workspace, candidate.bundle),
    directory: join(root, 'verification'), identity: { uid: process.getuid!(), gid: process.getgid!() },
    checks: [{ id: 'answer', interpreter: process.execPath, timeoutMs: 1000, script: "process.stdout.write(require('node:fs').readFileSync('answer.txt'))", stdoutSha256: hash('correct') }] };
  return { root, input, git, workspace, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('independent checkout acceptance binds exact commit, trusted policy and retained evidence', async () => {
  const f = await fixture();
  try {
    process.env.VERIFIER_UNRELATED_SECRET = 'must-not-inherit';
    f.input.checks[0]!.script = "if(process.env.VERIFIER_UNRELATED_SECRET)process.exit(9);process.stdout.write(require('node:fs').readFileSync('answer.txt'))";
    const result = await runCodeVerification(f.input);
    assert.equal(result.accepted, true); assert.equal(result.commit, f.input.candidate.commit);
    assert.equal(result.baseCommit, f.input.candidate.baseCommit); assert.equal(result.checks[0]!.stdoutSha256, hash('correct'));
    assert.deepEqual(JSON.parse(readFileSync(join(f.input.directory, 'verification.json'), 'utf8')), result);
    await assert.rejects(runCodeVerification(f.input), /EEXIST/);
  } finally { delete process.env.VERIFIER_UNRELATED_SECRET; f.close(); }
});

test('wrong output, failing check, timeout and overflow cannot be accepted', async () => {
  const f = await fixture();
  try {
    f.input.checks = [
      { id: 'wrong', interpreter: process.execPath, timeoutMs: 1000, script: "process.stdout.write('wrong')", stdoutSha256: hash('correct') },
      { id: 'failure', interpreter: process.execPath, timeoutMs: 1000, script: 'process.exit(3)' },
      { id: 'timeout', interpreter: process.execPath, timeoutMs: 150, script: 'setInterval(()=>{},1000)' },
      { id: 'overflow', interpreter: process.execPath, timeoutMs: 1000, script: "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)" },
    ];
    const result = await runCodeVerification(f.input); assert.equal(result.accepted, false);
    assert.deepEqual(result.checks.map(check => check.passed), [false, false, false, false]);
    assert.deepEqual(result.checks.map(check => check.reason), ['stdout_mismatch', 'exit', 'timeout', 'output_limit']);
  } finally { f.close(); }
});

test('changed bundle or false candidate identity prevents check execution', async () => {
  for (const kind of ['bytes', 'commit', 'parent', 'tree']) {
    const f = await fixture();
    try {
      const marker = join(f.root, 'ran');
      f.input.checks[0]!.script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`;
      if (kind === 'bytes') writeFileSync(f.input.candidateBundlePath, 'tampered');
      if (kind === 'commit') f.input.candidate.commit = 'a'.repeat(40);
      if (kind === 'parent') f.input.candidate.baseCommit = 'b'.repeat(40);
      if (kind === 'tree') f.input.candidate.tree = 'c'.repeat(40);
      await assert.rejects(runCodeVerification(f.input)); assert.equal(existsSync(marker), false);
    } finally { f.close(); }
  }
});


test('a correctly hashed bundle containing an escaping symlink is rejected before checkout and checks', async () => {
  for (const target of ['/etc/passwd', '../outside', '.git/config', 'answer.txt', 'missing']) {
  const f = await fixture();
  try {
    rmSync(f.input.candidateBundlePath);
    rmSync(join(f.workspace, 'answer.txt')); symlinkSync(target, join(f.workspace, 'answer.txt'));
    await f.git('add', '--all'); await f.git('commit', '-m', 'unsafe candidate');
    f.input.candidate.commit = await f.git('rev-parse', 'HEAD');
    f.input.candidate.tree = await f.git('rev-parse', 'HEAD^{tree}');
    await f.git('update-ref', 'refs/heads/factory-candidate', f.input.candidate.commit);
    await f.git('bundle', 'create', f.input.candidateBundlePath, f.input.candidate.baseCommit + '..refs/heads/factory-candidate');
    const bytes = readFileSync(f.input.candidateBundlePath); f.input.candidate.sha256 = hash(bytes); f.input.candidate.size = bytes.length;
    await assert.rejects(runCodeVerification(f.input), /candidate link/i);
    assert.equal(existsSync(join(f.input.directory, 'check-answer')), false);
  } finally { f.close(); }
  }
});


test('independent verification accepts confined file links and preserves the exact candidate tree',async()=>{
  const f=await fixture(true);try{
    f.input.checks[0]!.script="process.stdout.write(require('node:fs').readFileSync('docs/instructions'))";
    const result=await runCodeVerification(f.input);assert.equal(result.accepted,true);
    assert.equal(result.tree,f.input.candidate.tree);
    assert.equal(readlinkSync(join(f.input.directory,'workspace','AGENTS.md')),'answer.txt');
    assert.equal(readlinkSync(join(f.input.directory,'workspace','docs','instructions')),'../AGENTS.md');
  }finally{f.close();}
});
