/** Exercise the packaged local controller without provider or model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFactory, type ControllerOptions } from '../src/controller.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-controller-')));
const options: ControllerOptions = {
  factory: { project: 'verification', database: join(root, 'tasks.sqlite'), roles: {} }, stateRoot: root,
  repository: 'example/verification', workflows: {}, coordination: { maxAgents: 2, pollMs: 20 },
  binaries: { tart: '/unused/tart', tofu: '/unused/tofu', node: process.execPath },
  transport: { request: async () => { throw Error('No provider call is permitted'); } },
  checks: { subject: 'verification', authorize: async () => ({ status: 'denied', evidenceId: 'no-workloads' }), inspectSecret: async () => { throw Error('No secrets'); } },
  reportUsage: async () => { throw Error('No tasks'); }, verify: async () => { throw Error('No tasks'); },
};
try {
  const first = await startFactory(options);
  await assert.rejects(startFactory(options), /still be alive/);
  await first.close();
  const second = await startFactory({ ...options, coordination: { maxAgents: 1, pollMs: 20 } });
  await second.close();
  console.log('Local controller ownership and restart verified without provider or model calls.');
} finally { rmSync(root, { recursive: true, force: true }); }
