import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { prepareAgentSources, type RepositoryAcquisition } from '../src/agent-preparation.js';

test('short multi-repository YAML becomes exact clean checkouts and reuses immutable sources', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-preparation-')));
  const source = join(root, 'source'); mkdirSync(source);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(join(source, 'app.txt'), 'baseline'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  const commit = git('rev-parse', 'HEAD');
  const calls: string[] = [];
  const acquire: RepositoryAcquisition = {
    async resolve(repository, ref) { calls.push(`${repository}:${ref}`); return commit; },
    async checkout(_repository, sha, destination) {
      calls.push('clone'); git('clone', '--', source, destination);
      execFileSync('/usr/bin/git', ['checkout', '--detach', sha], { cwd: destination, stdio: 'pipe' });
    },
  };
  const options = { directory: join(root, 'sources'), workflowRepository: 'org/factory', codexSecret: 'CODEX_KEY', acquire };
  const yaml = 'schemaVersion: 1\nagents:\n  - {name: login, repository: org/app, prompt: Fix login}\n  - {name: docs, repository: org/docs, prompt: Fix docs, ref: main}\n  - {name: feature, repository: org/app, prompt: Add feature}\n';
  try {
    const result = parse(await prepareAgentSources(yaml, options));
    assert.equal(result.defaults.codexSecret, 'CODEX_KEY');
    assert.equal(result.agents[0].baseCommit, commit);
    assert.equal(result.agents[0].checkout, result.agents[2].checkout);
    assert.notEqual(result.agents[0].checkout, result.agents[1].checkout);
    assert.equal(result.agents[1].ref, undefined);
    assert.equal(calls.filter(c => c === 'clone').length, 2);
    await prepareAgentSources(yaml, options);
    assert.equal(calls.filter(c => c === 'clone').length, 2);
    writeFileSync(join(result.agents[0].checkout, 'app.txt'), 'tampered');
    await assert.rejects(prepareAgentSources(yaml, options), /changed/);
    assert.ok(calls.includes('org/docs:main'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid agent destinations and duplicate names fail before any source access', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-preparation-')));
  let accessed = false;
  const options = { directory: root, workflowRepository: 'org/factory', codexSecret: 'KEY', acquire: {
    async resolve() { accessed = true; return 'a'.repeat(40); }, async checkout() { accessed = true; },
  } };
  try {
    await assert.rejects(prepareAgentSources('schemaVersion: 1\nagents:\n  - {name: a, repository: ../escape, prompt: task}', options));
    assert.equal(accessed, false);
    await assert.rejects(prepareAgentSources('schemaVersion: 1\nagents:\n  - {name: a, repository: org/app, prompt: task}\n  - {name: a, repository: org/docs, prompt: task}', options));
    assert.equal(accessed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
