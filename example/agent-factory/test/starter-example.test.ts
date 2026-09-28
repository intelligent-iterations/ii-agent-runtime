import { factoryTartOptions } from '../src/defaults.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

// Exercise the actual installed controller against real Git source bundles.
test('YAML controller binds independent sources and credentials and rejects missing acceptance', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(packageRoot, '.starter-test-'));
  try {
    const source = join(root, 'source'); mkdirSync(source);
    const git = (...args: string[]) => execFileSync('git', args, {cwd:source,encoding:'utf8',stdio:'pipe'}).trim();
    git('init'); writeFileSync(join(source,'test.js'),'require("node:assert").equal(1+1,2)'); git('add','.');
    git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','base');
    const baseCommit = git('rev-parse','HEAD');
    const setup = {schemaVersion:1,id:'code',revision:'1',harness:{name:'codex',version:'0.156.1'},
      deployment:{provider: 'tart', options: factoryTartOptions(),image:'test@sha256:'+'a'.repeat(64),cpu:2,memoryMiB:2048},
      secrets:[{provider:'github',repository:'org/factory',key:'MODEL_KEY'}],capture:{paths:['candidate.bundle']}};
    const workflow = {id:1,ref:'approved',commit:'b'.repeat(40)};
    const appConfig = join(root, 'app.json');
    writeFileSync(appConfig, JSON.stringify({ appId: 1, key: {kind:'file',path:join(root,'unused.pem')}, revision:'test', approvedBy:'test', repositories:{'org/factory':{id:1,permissions:{contents:'write'}}} }));
    chmodSync(appConfig, 0o600);
    const installation = {project:'example',repository:'org/factory',directory:'./state',agentsManifest:'./resolved.yaml',appConfigPath:appConfig,
      roles:{code:{setup}}, workerWorkflow:workflow,verificationWorkflow:{...workflow,id:2},
      verificationSetup:{...setup,id:'verification',harness:{name:'verification',version:'1'},secrets:[],capture:{paths:['verification.json']}},
      binaries:{tart:'/usr/bin/true',tofu:'/usr/bin/true'},billing:{mode:'metered_api',provider:'openai'},
      acceptanceChecksByAgent:{} as Record<string,unknown>};
    writeFileSync(join(root,'resolved.yaml'),stringify({schemaVersion:1,defaults:{codexSecret:'MODEL_KEY'},agents:
      ['one','two'].map(name=>({name,repository:'org/app',prompt:'Fix '+name,baseCommit,checkout:source}))}));
    writeFileSync(join(root,'controller.mjs'),readFileSync(join(packageRoot,'examples/controller.mjs')));
    const config = join(root,'installation.json'); writeFileSync(config,JSON.stringify(installation));
    const run = () => execFileSync(process.execPath,['--input-type=module','-e',`
      globalThis.fetch=()=>{throw Error('Unexpected provider call');};
      const c=await import('./controller.mjs');try {console.log(JSON.stringify({client:c.client,workflows:c.default.workflows}));}finally{c.dispose();}
    `],{cwd:root,env:{...process.env,GITHUB_TOKEN:'synthetic-controller-token'},encoding:'utf8',stdio:'pipe'});
    assert.throws(run,/Invalid acceptance policy/);
    for(const name of ['one','two']) installation.acceptanceChecksByAgent[name]=[{id:'tests',interpreter:'/usr/local/bin/node',script:'require("node:assert").equal(1+1,2)',timeoutMs:1000}];
    writeFileSync(config,JSON.stringify(installation));
    const output=run();const result=JSON.parse(output);
    assert.deepEqual(Object.keys(result.client.roles),['one','two']);
    assert.equal(result.client.roles.one.credentialKey,result.client.roles.two.credentialKey);
    assert.deepEqual(Object.values(result.workflows),[workflow,workflow]);
    assert.equal(result.client.database,join(root,'state/work.sqlite'));
    assert.equal(output.includes('synthetic-controller-token'),false);
    writeFileSync(config,JSON.stringify({...installation,agentsManifest:undefined}));
    assert.throws(run,/prepared agent manifest/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
