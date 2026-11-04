import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dockerTofuTarget } from '../../../../src/providers/execution/docker/target.js';
import { executionServices } from '../../../../src/providers/services.js';
import { workerResources } from '../../../../src/pipeline/worker-resources.js';
import { compileConfiguration } from '../../../../src/runtime/configuration.js';
import { fixture } from '../../../runtime-fixture.js';

test('Docker target forwards run context and never suppresses failed cleanup when state is missing', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-target-test-')));
  const marker = randomUUID();
  writeFileSync(join(parent, '.owner'), marker, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(parent, '.owner'), 'utf8'), marker); rmSync(parent, { recursive: true }); });
  const context = { deadlineMs: Date.now() + 1000, signal: new AbortController().signal };
  let work = '';
  let owner = '';
  const target = dockerTofuTarget({ parent, executablePath: '/trusted/bin', services: {
    ...executionServices,
    openTofuWorker: options => {
      work = options.parent;
      owner = readFileSync(join(work, '.owner'), 'utf8');
      return {
        async provision(_resources, actualContext) {
          assert.equal(actualContext, context);
          throw Error('Partial provisioning');
        },
        async close() {
          assert.equal(readFileSync(join(work, '.owner'), 'utf8'), owner);
          rmSync(work, { recursive: true });
          throw Error('Provider cleanup unconfirmed');
        },
      };
    },
  } });
  await assert.rejects(target.provision(workerResources(compileConfiguration(fixture())), context), /Partial provisioning/);
  await assert.rejects(target.close(), /Provider cleanup unconfirmed/);
});

test('Docker target removes owned state after provisioner construction failure and cannot restart', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-target-init-')));
  const marker = randomUUID();
  writeFileSync(join(parent, '.owner'), marker, { flag: 'wx' });
  t.after(() => { assert.equal(readFileSync(join(parent, '.owner'), 'utf8'), marker); rmSync(parent, { recursive: true }); });
  const target = dockerTofuTarget({ parent, executablePath: '/trusted/bin', services: {
    ...executionServices, openTofuWorker: () => { throw Error('Initialization failed'); },
  } });
  const resources = workerResources(compileConfiguration(fixture()));
  await assert.rejects(target.provision(resources), /Initialization failed/);
  await target.close();
  await target.close();
  await assert.rejects(target.provision(resources), /already used/);
  assert.deepEqual((await import('node:fs')).readdirSync(parent), ['.owner']);
});
