import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRequest } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { cloneRepository } from '../src/github-checkout.js';
import { planSetup } from '../src/setup-plan.js';
import { fixture } from './pipeline-fixture.js';

test('the host checkout passes its token through git\'s environment, never its arguments, and runs no hooks or submodules', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-clone-')));
  t.after(() => rmSync(directory, { recursive: true }));
  let seen: ProcessRequest | undefined;
  const path = await cloneRepository({ repository: 'example/project', base: 'dev', token: 'synthetic-read-token', directory, executablePath: '/usr/bin',
    process: async request => { seen = request; return ''; } });
  assert.equal(path, join(directory, 'repository'));
  assert.ok(!seen!.args.join(' ').includes('synthetic-read-token'));
  assert.ok(seen!.args.includes('--no-recurse-submodules') && seen!.args.includes('--depth=1'));
  assert.deepEqual(seen!.args.slice(seen!.args.indexOf('--branch'), seen!.args.indexOf('--branch') + 2), ['--branch', 'dev']);
  assert.equal(seen!.env.GIT_CONFIG_VALUE_1, '/dev/null');
  assert.match(seen!.env.GIT_CONFIG_VALUE_0!, /^AUTHORIZATION: basic /);
  assert.equal(seen!.env.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('setup follows the repository\'s lockfiles unless the configuration sets commands or turns it off', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-plan-')));
  t.after(() => rmSync(directory, { recursive: true }));
  const environment = fixture().environment;
  assert.equal(planSetup(environment, directory), undefined, 'no lockfile, no setup');
  writeFileSync(join(directory, 'package-lock.json'), '{}');
  assert.deepEqual(planSetup(environment, directory), { label: 'npm ci', commands: ['npm ci --no-audit --no-fund'], timeoutMs: 600000 });
  writeFileSync(join(directory, 'pnpm-lock.yaml'), '');
  writeFileSync(join(directory, 'requirements.txt'), '');
  assert.deepEqual(planSetup(environment, directory)!.commands, ['corepack pnpm install --frozen-lockfile', 'python3 -m venv .venv', '.venv/bin/pip install --no-input -r requirements.txt']);
  assert.equal(planSetup({ ...environment, setup: { enabled: false } }, directory), undefined);
  assert.deepEqual(planSetup({ ...environment, setup: { enabled: true, timeoutMinutes: 3, commands: ['make deps'] } }, directory),
    { label: 'make deps', commands: ['make deps'], timeoutMs: 180000 });
});
