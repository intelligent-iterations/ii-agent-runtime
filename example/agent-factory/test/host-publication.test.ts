import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealCodeCandidate } from '../src/code-candidate.js';
import { createHostPublisher } from '../src/host-publication.js';
import type { createGitHubApp } from '../src/github-app.js';
import type { ExecutionContext } from '../src/local-coordinator.js';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
test('host publishes only the retained candidate and reconciles the exact branch', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-host-publish-')));
  const source = join(root, 'source'); const workspace = join(root, 'workspace'); const remote = join(root, 'remote.git');
  mkdirSync(source);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git(source, 'init'); writeFileSync(join(source, 'answer.txt'), 'old'); git(source, 'add', '.'); git(source, 'commit', '-m', 'base');
    const baseCommit = git(source, 'rev-parse', 'HEAD');
    git(root, 'clone', source, workspace);
    writeFileSync(join(workspace, 'answer.txt'), 'new');
    const candidate = await sealCodeCandidate({ workspace, directory: join(root, 'candidate'), baseCommit, secretValues: [] });
    const baseBundle = join(root, 'source.bundle'); git(source, 'bundle', 'create', baseBundle, 'HEAD');
    git(root, 'init', '--bare', remote);
    const records = new Map<string, unknown>();
    const context = { task: { id: 'task', input: JSON.stringify({ repository: 'org/a', baseCommit }) }, attemptId: 'attempt',
      record: (key: string) => records.get(key) ?? null, checkpoint: (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
      cancelled: () => false } as ExecutionContext;
    let issued = 0;
    const app = { withToken: async (_input: unknown, operation: (token: string) => Promise<unknown>) => { issued++; return operation('synthetic-token'); } } as unknown as ReturnType<typeof createGitHubApp>;
    const publish = createHostPublisher({ app, baseBundle: async () => ({ path: baseBundle, sha256: sha(baseBundle) }), testRemote: remote });
    const retained = { worker: { candidate }, files: [{ path: 'candidate.bundle', localPath: join(workspace, 'candidate.bundle'),
      sha256: candidate.sha256, size: candidate.size }] };
    const result = await publish(context, retained);
    assert.equal(git(root, 'ls-remote', remote, result.ref), `${candidate.commit}\t${result.ref}`);
    assert.deepEqual(await publish(context, retained), result);
    assert.equal(issued, 2);
    writeFileSync(join(workspace, 'candidate.bundle'), 'tampered');
    await assert.rejects(publish(context, retained), /invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
