import { testTartOptions } from '../test/fixtures/provider-options.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { compileSetup, compileSetupJson, compileSetupYaml, defineSetup, prepareTartDeployment } from '../src/index.js';

const tofu = execFileSync('which', ['tofu'], { encoding: 'utf8' }).trim();
test('libvirt module plans one owned VM without provider plugins or side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-libvirt-tofu-'));
  try {
    copyFileSync(resolve('modules/libvirt/main.tf'), join(root, 'main.tf'));
    writeFileSync(join(root, 'terraform.tfvars.json'), JSON.stringify({
      manifest_path: '/operator/operation/manifest.json', node_binary: process.execPath,
      hook_script: '/operator/runtime/libvirt-hook.js',
    }));
    execFileSync(tofu, ['init', '-backend=false', '-input=false', '-no-color'], { cwd: root, stdio: 'pipe' });
    execFileSync(tofu, ['validate', '-no-color'], { cwd: root, stdio: 'pipe' });
    execFileSync(tofu, ['plan', '-input=false', '-no-color', '-out=preview.tfplan'], { cwd: root, stdio: 'pipe' });
    const plan = JSON.parse(execFileSync(tofu, ['show', '-json', 'preview.tfplan'], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(plan.resource_changes.map((item: { type: string; change: { actions: string[] } }) =>
      ({ type: item.type, actions: item.change.actions })), [{ type: 'terraform_data', actions: ['create'] }]);
    assert.equal(existsSync(join(root, 'terraform.tfstate')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real OpenTofu invokes packaged hooks, retains state, and destroys a configured synthetic VM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-tofu-contract-'));
  try {
    const manifest = prepareTartDeployment(root, { schemaVersion: 1, id: 'test', revision: '1', harness: { name: 'example', version: '1' },
      deployment: { provider: 'tart', options: testTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 3, memoryMiB: 3072 }, secrets: [], capture: { paths: [] } },
    { node: process.execPath, tofu, tart: resolve('test/fixtures/tart-command.mjs') });
    const path = join(manifest.directory, 'manifest.json');
    // Runtime source points to JS hooks beside itself. Test the built package via its entry point.
    const runtime = await import(new URL('../dist/index.js', import.meta.url).href);
    const context = { subject: 'test', authorize: async () => ({ status: 'verified', evidenceId: 'test' }), inspectSecret: async () => assert.fail() };
    await assert.rejects(runtime.planTart(path, { ...context, authorize: async () => ({status:'denied', evidenceId:'revoked'}) }));
    assert.equal(existsSync(join(manifest.directory, 'tofu/main.tf')), false);
    const preview = await runtime.planTart(path, context);
    assert.deepEqual(preview.changes, {create:1,update:0,delete:0,read:0,unchanged:0});
    assert.equal(preview.scope, 'opentofu-state');
    const checker = join(root, 'checker');
    writeFileSync(checker, `#!${process.execPath}
const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(request.operation==='identify'?{subject:'test'}:{status:'verified',evidenceId:'test'}));
`, {mode:0o700});
    const cliArgs = [resolve('dist/cli.js'),'check','--format','json','--checker',checker,'--plan',path];
    const cliPlan = JSON.parse(execFileSync(process.execPath, cliArgs, {input:JSON.stringify(manifest.setup),encoding:'utf8'}));
    assert.deepEqual(cliPlan.changes, preview.changes);
    const mismatch = spawnSync(process.execPath, cliArgs, {input:JSON.stringify({...manifest.setup,revision:'different'}),encoding:'utf8'});
    assert.equal(mismatch.status,1); assert.equal(JSON.parse(mismatch.stderr).error.code,'CHECK_FAILED');
    await assert.rejects(runtime.planTart(path, context, {run:async()=>{throw Error('synthetic-private-value');}}));
    assert.ok(!readdirSync(manifest.directory).some(name=>name.startsWith('plan-')));
    assert.equal(existsSync(join(manifest.directory,'mutation.lock')),false);

    assert.equal(existsSync(join(manifest.directory, 'tart/synthetic-vm.json')), false);
    assert.ok(!readdirSync(manifest.directory).some(name=>name.startsWith('plan-')));
    const result = await runtime.deployTart(path, { subject: 'test', authorize: async () => ({ status: 'verified', evidenceId: 'test' }), inspectSecret: async () => assert.fail() });
    assert.deepEqual((await runtime.planTart(path, context)).changes, {create:0,update:0,delete:0,read:0,unchanged:1});
    assert.equal(result.cpu, 3); assert.equal(result.memoryMiB, 3072);
    const state = JSON.parse(readFileSync(join(manifest.directory, 'tofu/terraform.tfstate'), 'utf8'));
    assert.equal(state.resources[0].type, 'terraform_data');
    assert.equal(state.resources[0].instances[0].attributes.input.value.manifest_path, path);
    assert.equal((await runtime.destroyTart(path)).present, false);
    assert.equal((await runtime.destroyTart(path)).present, false);
  } finally { rmSync(root, { recursive: true }); }
});

test('real tainted-resource destroy skips provisioner but runtime recovery still removes owned VM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-tofu-taint-'));
  try {
    const manifest = prepareTartDeployment(root, { schemaVersion: 1, id: 'test', revision: '1', harness: { name: 'example', version: '1' },
      deployment: { provider: 'tart', options: testTartOptions(), image: `registry.example/base@sha256:${'a'.repeat(64)}`, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } },
    { node: process.execPath, tofu, tart: resolve('test/fixtures/tart-command.mjs') });
    const path = join(manifest.directory, 'manifest.json');
    const runtime = await import(new URL('../dist/index.js', import.meta.url).href);
    await runtime.deployTart(path, { subject: 'test', authorize: async () => ({ status: 'verified', evidenceId: 'test' }), inspectSecret: async () => assert.fail() });
    execFileSync(tofu, ['taint', 'terraform_data.vm'], { cwd: join(manifest.directory, 'tofu'), stdio: 'pipe' });
    execFileSync(tofu, ['destroy', '-auto-approve', '-input=false'], { cwd: join(manifest.directory, 'tofu'), stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(manifest.directory, 'tart/synthetic-vm.json'), 'utf8')).present, true, 'tainted destruction skipped the hook');
    assert.equal((await runtime.destroyTart(path)).present, false);
    const vm = JSON.parse(readFileSync(join(manifest.directory, 'tart/synthetic-vm.json'), 'utf8'));
    assert.equal(vm.present, false);
  } finally { rmSync(root, { recursive: true }); }
});


test('JSON, YAML and typed setups retain identical provider inputs and have no OpenTofu changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-tofu-authoring-'));
  const runtime = await import(new URL('../dist/index.js', import.meta.url).href);
  const json = readFileSync(resolve('test/fixtures/authoring-setup.json'), 'utf8');
  const yaml = readFileSync(resolve('test/fixtures/authoring-setup.yaml'), 'utf8');
  const compiled = [compileSetupJson(json), compileSetupYaml(yaml), compileSetup(defineSetup(JSON.parse(json))),
    compileSetupYaml('# source-only edit\n' + yaml.replace('cpu: 2', 'cpu: 2 # same resources'))];
  const context = { subject: 'test', authorize: async () => ({ status: 'verified', evidenceId: 'caller' }),
    inspectSecret: async () => ({ status: 'verified', evidenceId: 'secret' }) };
  try {
    for (const artifact of compiled) {
      assert.equal(artifact.json, compiled[0]!.json); assert.equal(artifact.digest, compiled[0]!.digest);
      const manifest = prepareTartDeployment(root, JSON.parse(artifact.json),
        { node: process.execPath, tofu, tart: resolve('test/fixtures/tart-command.mjs') });
      assert.deepEqual(manifest.setup, compiled[0]!.setup); assert.equal(manifest.digest, compiled[0]!.digest);
      const path = join(manifest.directory, 'manifest.json');
      try {
        await runtime.deployTart(path, context);
        // A source-format edit produces the same immutable operation inputs. Exit 2 would mean changes.
        execFileSync(tofu, ['plan', '-input=false', '-no-color', '-detailed-exitcode'], {
          cwd: join(manifest.directory, 'tofu'), stdio: 'pipe' });
      } finally { assert.equal((await runtime.destroyTart(path)).present, false); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
