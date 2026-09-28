import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GitHubTransport } from '@intelligent-iterations/ii-agent-runtime';
import { checkCodeInstallation } from '../src/installation-preflight.js';

test('coding readiness verifies real full bundles and rejects missing ancestry, changed bytes and wrong commit', async()=>{
  const root=mkdtempSync(join(tmpdir(),'factory-preflight-'));
  const git=(...args:string[])=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Proof',GIT_AUTHOR_EMAIL:'proof@localhost',GIT_COMMITTER_NAME:'Proof',GIT_COMMITTER_EMAIL:'proof@localhost'}}).trim();
  try{
    git('init');writeFileSync(join(root,'data'),'first');git('add','data');git('commit','-m','first');const first=git('rev-parse','HEAD');
    writeFileSync(join(root,'data'),'second');git('commit','-am','second');const commit=git('rev-parse','HEAD');
    const bundle=join(root,'base.bundle');git('bundle','create',bundle,'HEAD');
    const digest=()=>createHash('sha256').update(readFileSync(bundle)).digest('hex');
    let state='active';let sha='a'.repeat(40);let allowed=true;
    const transport:GitHubTransport={request:async(method,path)=>{
      assert.equal(method,'GET');
      return {status:200,body:path.includes('/actions/workflows/')?{state}:{sha}};
    }};
    const options={repository:'private/factory',transport,checks:{subject:'operator',authorize:async()=>({status:allowed?'verified' as const:'denied' as const,evidenceId:'policy'}),inspectSecret:async()=>{throw Error('Verifier must have no secrets');}},
      verificationSetup:{schemaVersion:1 as const,id:'verify',revision:'1',harness:{name:'verification',version:'1'},deployment:{provider:'tart' as const,image:`registry/image@sha256:${'b'.repeat(64)}`,cpu:2,memoryMiB:2048},secrets:[],capture:{paths:['verification.json']}},
      verificationWorkflow:{id:1,ref:'approved',commit:sha},source:{repository:'public/source',commit,bundle,sha256:digest()}};
    const proof=await checkCodeInstallation(options);assert.equal(proof.source.commit,commit);
    state='disabled_manually';await assert.rejects(checkCodeInstallation(options),/disabled/);state='active';
    sha='c'.repeat(40);await assert.rejects(checkCodeInstallation(options),/approved commit/);sha='a'.repeat(40);
    allowed=false;await assert.rejects(checkCodeInstallation(options),/authorization/);allowed=true;
    await assert.rejects(checkCodeInstallation({...options,source:{...options.source,commit:first}}),/advertise/);
    writeFileSync(bundle,'corrupt');await assert.rejects(checkCodeInstallation(options),/digest/);
    options.source.sha256=digest();await assert.rejects(checkCodeInstallation(options),/invalid/);
    rmSync(bundle);git('bundle','create',bundle,`${first}..HEAD`);options.source.sha256=digest();
    await assert.rejects(checkCodeInstallation(options),/missing objects/);
    await assert.rejects(checkCodeInstallation({...options,verificationSetup:{...options.verificationSetup,secrets:[{provider:'github',repository:'private/factory',key:'TOKEN'}]}}),/credential-free/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
