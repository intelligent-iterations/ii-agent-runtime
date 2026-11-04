import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dockerDiskWorkspace } from '../../../../src/providers/execution/docker/workspace.js';
import type { ProcessRequest } from '../../../../src/providers/shared/process.js';

function fixture(t: TestContext, fault = '') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-disk-'))), marker = randomUUID();
  writeFileSync(join(directory, '.owner'), marker);
  t.after(() => { assert.equal(readFileSync(join(directory, '.owner'), 'utf8'), marker); rmSync(directory, { recursive: true }); });
  const owner = 'a'.repeat(32), volume = `agent-runtime-disk-${owner}`;
  let present = false;
  const calls: Array<{ request: ProcessRequest; cleanup: boolean }> = [];
  const options = { owner, directory, image: 'example/helper@sha256:' + 'b'.repeat(64), diskGiB: 40, environment: { PATH: '/trusted' },
    execute: async (request: ProcessRequest, cleanup: boolean) => {
      calls.push({ request, cleanup });
      if (request.command === 'tofu' && request.args[0] === 'apply') { present = true; if (fault === 'apply') throw Error('lost-apply'); }
      if (request.command === 'tofu' && request.args[0] === 'output') return JSON.stringify({ volume_name: { value: volume } });
      if (request.args[0] === 'volume' && request.args[1] === 'inspect') return JSON.stringify([{ Name: volume, Driver: 'local', Labels: { 'agent-runtime.owner': fault === 'ownership' ? 'another' : owner } }]);
      if (request.args[0] === 'volume' && request.args[1] === 'ls') return present ? volume : '';
      if (request.args[0] === 'run' && request.args.at(-3) === 'create') {
        if (fault === 'helper') throw Error('lost-helper');
        return JSON.stringify({ device: '/dev/loop7', sizeBytes: 40 * 1073741824 });
      }
      if (request.command === 'tofu' && request.args[0] === 'destroy') present = false;
      return '';
    },
  };
  return { directory, options, calls };
}

test('disk workspace is explicitly bounded and owned; cleanup detaches before removing its backing volume', async t => {
  const { directory, options, calls } = fixture(t), workspace = dockerDiskWorkspace(options);
  assert.deepEqual(await workspace.create(), { device: '/dev/loop7', sizeBytes: 40 * 1073741824 });
  for (const file of ['main.tf', '.terraform.lock.hcl']) assert.equal(statSync(join(directory, 'disk', file)).mode & 0o777, 0o600);
  await workspace.close(); await workspace.close();
  assert.deepEqual(readdirSync(directory), ['.owner']);
  const helpers = calls.filter(call => call.request.args[0] === 'run');
  assert.equal(helpers.length, 2);
  assert.ok(!helpers[0]!.request.args.includes('--privileged'));
  assert.ok(!helpers[0]!.request.args.includes('/var/run/docker.sock'));
  assert.ok(helpers[0]!.request.args.includes('SYS_ADMIN'));
  const remove = calls.findIndex(call => call.request.args.at(-3) === 'remove');
  const destroy = calls.findIndex(call => call.request.command === 'tofu' && call.request.args[0] === 'destroy');
  assert.ok(remove >= 0 && destroy > remove);
  assert.ok(calls.slice(remove).every(call => call.cleanup));
});

test('a lost volume apply or helper reply still reconciles the exact owned backing filesystem', async t => {
  for (const fault of ['apply', 'helper']) {
    const { directory, options, calls } = fixture(t, fault), workspace = dockerDiskWorkspace(options);
    await assert.rejects(workspace.create(), /lost-/);
    await workspace.close();
    assert.ok(calls.some(call => call.request.args.at(-3) === 'remove' && call.cleanup));
    assert.deepEqual(readdirSync(directory), ['.owner']);
  }
});

test('changed volume ownership is preserved without detaching or destroying it', async t => {
  const { options, calls } = fixture(t, 'ownership'), workspace = dockerDiskWorkspace(options);
  await assert.rejects(workspace.create(), /ownership changed/);
  await assert.rejects(workspace.close(), /ownership changed/);
  assert.equal(calls.some(call => call.request.args.at(-3) === 'remove' || call.request.args[0] === 'destroy'), false);
});

test('disk helper rejects mutable images and invalid sizes before effects', t => {
  const { options } = fixture(t);
  for (const value of [0, 81, 1.5]) assert.throws(() => dockerDiskWorkspace({ ...options, diskGiB: value }));
  assert.throws(() => dockerDiskWorkspace({ ...options, image: 'example/helper:latest' }));
});
