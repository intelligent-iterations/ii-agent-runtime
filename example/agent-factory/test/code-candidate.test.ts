import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sealCodeCandidate } from '../src/code-candidate.js';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-candidate-')));
  const source = join(root, 'source'); const workspace = join(root, 'workspace'); const verifier = join(root, 'verifier');
  mkdirSync(source); mkdirSync(verifier);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)('/usr/bin/git', args, { cwd, env })).stdout.trim();
  await git(source, 'init');
  writeFileSync(join(source, 'answer.txt'), 'wrong'); writeFileSync(join(source, 'deleted.txt'), 'remove me');
  writeFileSync(join(source, '.gitignore'), 'tracked.txt\nignored.txt\n'); writeFileSync(join(source, 'tracked.txt'), 'tracked despite ignore');
  await git(source, 'add', '--force', '.'); await git(source, 'commit', '-m', 'base');
  writeFileSync(join(source, 'history.txt'), 'second commit'); await git(source, 'add', '.'); await git(source, 'commit', '-m', 'second');
  const baseCommit = await git(source, 'rev-parse', 'HEAD');
  await git(root, 'clone', '--depth=1', 'file://' + source, workspace);
  return { root, source, workspace, verifier, baseCommit, git,
    seal: (secretValues: string[] = [], maxBytes?: number) => sealCodeCandidate({ workspace, directory: join(root, 'candidate'), baseCommit, secretValues, ...(maxBytes === undefined ? {} : { maxBytes }) }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test('sealed candidate imports into an independent checkout with exact commit, parent, tree and edits', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.workspace, 'answer.txt'), 'correct'); writeFileSync(join(f.workspace, 'new.txt'), 'new');
    writeFileSync(join(f.workspace, 'ignored.txt'), 'ignore this'); rmSync(join(f.workspace, 'deleted.txt'));
    // Agent-controlled Git hooks/config must not be imported into the sealing repository.
    const hook = join(f.workspace, '.git/hooks/pre-commit'); writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const candidate = await f.seal();
    await f.git(f.verifier, 'init'); await f.git(f.verifier, 'fetch', '--depth=1', f.source, f.baseCommit);
    await f.git(f.verifier, 'bundle', 'verify', join(f.workspace, candidate.bundle));
    await f.git(f.verifier, 'fetch', join(f.workspace, candidate.bundle), 'refs/heads/factory-candidate');
    assert.equal(await f.git(f.verifier, 'rev-parse', 'FETCH_HEAD'), candidate.commit);
    assert.equal(await f.git(f.verifier, 'rev-parse', candidate.commit + '^'), f.baseCommit);
    assert.equal(await f.git(f.verifier, 'rev-parse', candidate.commit + '^{tree}'), candidate.tree);
    await f.git(f.verifier, 'checkout', '--detach', candidate.commit);
    assert.equal(readFileSync(join(f.verifier, 'answer.txt'), 'utf8'), 'correct');
    assert.equal(readFileSync(join(f.verifier, 'new.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(f.verifier, 'tracked.txt'), 'utf8'), 'tracked despite ignore');
    assert.equal(existsSync(join(f.verifier, 'deleted.txt')), false); assert.equal(existsSync(join(f.verifier, 'ignored.txt')), false);
    await assert.rejects(f.seal(), /EEXIST/);
  } finally { f.close(); }
});

test('known secrets, oversized bytes and links are rejected before a bundle can be retained', async () => {
  for (const kind of ['secret', 'size', 'link']) {
    const f = await fixture();
    try {
      if (kind === 'secret') writeFileSync(join(f.workspace, 'answer.txt'), 'synthetic-credential');
      if (kind === 'link') { rmSync(join(f.workspace, 'answer.txt')); symlinkSync('/etc/passwd', join(f.workspace, 'answer.txt')); }
      await assert.rejects(f.seal(['synthetic-credential'], kind === 'size' ? 8 : undefined));
      assert.equal(existsSync(join(f.workspace, 'candidate.bundle')), false);
    } finally { f.close(); }
  }
});

test('an agent-supplied bundle cannot replace the controller-generated candidate', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.workspace, 'candidate.bundle'), 'agent supplied');
    await assert.rejects(f.seal(), /reserved/);
    assert.equal(readFileSync(join(f.workspace, 'candidate.bundle'), 'utf8'), 'agent supplied');
  } finally { f.close(); }
});


test('safe file links and relative chains preserve Git link mode and target bytes',async()=>{
  const f=await fixture();try{
    symlinkSync('answer.txt',join(f.workspace,'AGENTS.md'));mkdirSync(join(f.workspace,'docs'));
    symlinkSync('../AGENTS.md',join(f.workspace,'docs','instructions'));
    const candidate=await f.seal();
    await f.git(f.verifier,'init');await f.git(f.verifier,'fetch',f.source,f.baseCommit);
    await f.git(f.verifier,'fetch',join(f.workspace,candidate.bundle),'refs/heads/factory-candidate');
    await f.git(f.verifier,'checkout','--detach',candidate.commit);
    assert.match(await f.git(f.verifier,'ls-tree','HEAD','AGENTS.md'),/^120000 blob/);
    assert.equal(readlinkSync(join(f.verifier,'AGENTS.md')),'answer.txt');
    assert.equal(readlinkSync(join(f.verifier,'docs','instructions')),'../AGENTS.md');
    assert.equal(readFileSync(join(f.verifier,'docs','instructions'),'utf8'),'wrong');
    assert.equal(await f.git(f.verifier,'rev-parse','HEAD^{tree}'),candidate.tree);
  }finally{f.close();}
});

test('escaping, dangling, cyclic, Git-internal and directory links cannot be sealed',async()=>{
  for(const target of ['../outside','.git/config','missing','AGENTS.md','docs']){
    const f=await fixture();try{
      mkdirSync(join(f.workspace,'docs'));writeFileSync(join(f.workspace,'docs','a'),'a');
      symlinkSync(target,join(f.workspace,'AGENTS.md'));
      await assert.rejects(f.seal(),/Candidate link|Unsafe candidate link/);
      assert.equal(existsSync(join(f.workspace,'candidate.bundle')),false);
    }finally{f.close();}
  }
});
