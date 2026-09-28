import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSetup, setupDigest, checkSetup, inspectGitHubSecret, createTelemetryCollector, runnerIntent, registerGitHubRunner, prepareTartDeployment, startTartVM, executeTartGuest, deployTart, type TelemetryStore, type TelemetryRecord, type Setup, type CheckContext } from '../src/index.js';
import { tartOptions } from '../src/deployment/tart-options.js';
import type { CommandExecutor } from '../src/deployment/commands.js';
import { commands, toolEnvironment } from '../src/deployment/commands.js';
import { testTartOptions } from './fixtures/provider-options.js';
const setup = (): Setup => ({schemaVersion:1,id:'consumer',revision:'1',harness:{name:'custom',version:'1'},
  deployment:{provider:'tart',image:'test@sha256:'+'a'.repeat(64),cpu:1,memoryMiB:512,options:testTartOptions()},secrets:[],capture:{paths:[]}});
const checks: CheckContext = {subject:'caller',authorize:async()=>({status:'verified',evidenceId:'caller'}),inspectSecret:async()=>({status:'unknown',evidenceId:'unsupported'})};

test('missing or malformed deployment policy cannot allocate state', () => {
  const root=mkdtempSync(join(tmpdir(),'runtime-policy-'));
  try {
    for(const options of [undefined,{}, {...testTartOptions(),unexpected:true}, {...testTartOptions(),timeouts:{}}, {...testTartOptions(),network:{mode:'softnet',blockHostAddresses:true,blockCidrs:['10.0.0.0/99']}}]) {
      const s=setup();if(options===undefined)delete s.deployment.options;else s.deployment.options=options;
      assert.throws(()=>prepareTartDeployment(root,s,{node:process.execPath,tart:'/tool/tart',tofu:'/tool/tofu'}));
      assert.deepEqual(readdirSync(root),[]);
    }
  } finally {rmSync(root,{recursive:true});}
});

test('consumer network, OS and timeouts reach provider commands and authorization identity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runtime-policy-'));const s=setup();const policy=testTartOptions();
  policy.os='darwin';policy.network={mode:'softnet',blockCidrs:['203.0.113.0/24'],blockHostAddresses:false};
  policy.timeouts={commandMs:1234,guestCommandMs:2345,addressWaitMs:3456,tofuMs:4567,tofuLockMs:5678};
  s.deployment.options=policy;
  const operations:Array<{args:string[];timeout:number}>=[];let running=false;
  const driver:CommandExecutor={async run(binary,args,options){
    operations.push({args,timeout:options.timeoutMs});
    if(binary==='/tool/tofu')return '';
    if(args[0]==='list')return JSON.stringify([{Name:m.vmName,Source:'local',Running:running}]);
    if(args[0]==='get')return JSON.stringify({CPU:1,Memory:512,OS:'darwin',Running:running});
    if(args[0]==='exec')return 'guest';
    throw Error('Unexpected command');
  },async start(_binary,args,options){operations.push({args,timeout:options.timeoutMs});running=true;}};
  const m=prepareTartDeployment(root,s,{node:process.execPath,tart:'/tool/tart',tofu:'/tool/tofu'});
  try {
    // Model the hook having configured the owned VM, without claiming a real macOS VM proof.
    const {writeFileSync}=await import('node:fs');writeFileSync(join(m.directory,'phase.json'),JSON.stringify({phase:'configured'}));
    const manifest=join(m.directory,'manifest.json');let authorizedDigest='';
    await deployTart(manifest,{...checks,authorize:async(_subject,input)=>{authorizedDigest=setupDigest(input);return {status:'verified',evidenceId:'exact'};}},driver);
    await startTartVM(manifest,driver);assert.equal(await executeTartGuest(manifest,['true'],undefined,driver),'guest');
    assert.equal(authorizedDigest,setupDigest(s));
    assert.ok(operations.some(x=>x.args.includes('-lock-timeout=5678ms')&&x.timeout===4567));
    const start=operations.find(x=>x.args[0]==='run')!;
    assert.ok(start.args.includes('--net-softnet-block=203.0.113.0/24'));assert.equal(start.timeout,1234);
    assert.equal(operations.find(x=>x.args[0]==='exec')!.timeout,2345);
    for(const field of ['os','network','timeouts'] as const){const changed=setup();changed.deployment.options![field]=policy[field];assert.notEqual(setupDigest(setup()),setupDigest(changed));}
  } finally {rmSync(root,{recursive:true});}
});

test('provider-neutral references need explicit evidence and never call the GitHub adapter',async()=>{
  const s=setup();s.secrets=[{provider:'custom-vault',resource:'tenant/project/secret',key:'version-7'}];
  assert.deepEqual(parseSetup(s).secrets,s.secrets);assert.equal((await checkSetup(s,checks)).allowed,false);
  let calls=0;const result=await inspectGitHubSecret({async request(){calls++;throw Error('Wrong provider');}},s.secrets[0]!);
  assert.equal(result.status,'unknown');assert.equal(calls,0);
  const allowed=await checkSetup(s,{...checks,inspectSecret:async ref=>{assert.deepEqual(ref,s.secrets[0]);return {status:'verified',evidenceId:'custom-provider'};}});
  assert.equal(allowed.allowed,true);
  const changed=structuredClone(s);(changed.secrets[0] as {resource:string}).resource='different';assert.notEqual(setupDigest(s),setupDigest(changed));
  assert.throws(()=>parseSetup({...s,secrets:[{...s.secrets[0],value:'not-allowed'}]}));
  assert.throws(()=>parseSetup({...s,secrets:[{provider:'github',resource:'not-a-github-ref',key:'TOKEN'}]}));
});

test('a non-SQLite asynchronous store receives only redacted correlated events',async()=>{
  const root=mkdtempSync(join(tmpdir(),'runtime-custom-store-'));const records:TelemetryRecord[]=[];let opens=0,closed=0;
  const store:TelemetryStore={async recordEvent(event){
    if(records.some(r=>r.dedupKey===event.dedupKey))return null;
    const record={...event,id:String(records.length),sessionId:null,turnId:null,timestamp:'now',createdAt:'now',dedupKey:event.dedupKey??null,payloadJson:JSON.stringify(event.payload),redactionVersion:'custom',schemaVersion:'custom'};
    records.push(record);return record;
  },listEvents(){return records;},close(){closed++;}};
  try {
    assert.throws(()=>createTelemetryCollector({setup:setup(),executionId:'invalid id',attemptId:'attempt',openStore(){opens++;return store;}}));assert.equal(opens,0);
    const collector=createTelemetryCollector({setup:setup(),executionId:'run',attemptId:'attempt',secretValues:['hidden-value'],openStore(){opens++;return store;}});
    const event={source:'agent' as const,kind:'hook' as const,eventType:'test',dedupKey:'one',payload:{text:'hidden-value'}};
    assert.equal((await collector.publish(event)).accepted,true);assert.equal((await collector.publish(event)).accepted,false);
    assert.equal(opens,1);assert.equal(records.length,1);assert.doesNotMatch(JSON.stringify(records),/hidden-value/);
    assert.equal((records[0]!.payload as any).runtime.setupDigest,setupDigest(setup()));assert.deepEqual(readdirSync(root),[]);
    collector.close();collector.close();assert.equal(closed,1);
    await assert.rejects(collector.publish(event),/closed/);assert.equal(records.length,1);
  } finally {rmSync(root,{recursive:true});}
});

test('runner group and work folder are explicit, persisted and passed to GitHub',async()=>{
  const intent=runnerIntent('org/repo',{groupId:17,workFolder:'custom-work'});let body:any;
  await registerGitHubRunner({async request(method,_path,input){if(method==='GET')return {status:200,body:{total_count:0,runners:[]}};
    body=input;return {status:201,body:{encoded_jit_config:'test',runner:{id:1,name:intent.name,labels:[{name:intent.ownershipLabel}],status:'offline',busy:false}}};}},intent,
    {async intent(saved){assert.equal(saved.groupId,17);assert.equal(saved.workFolder,'custom-work');},async receipt(){}},async()=>{});
  assert.equal(body.runner_group_id,17);assert.equal(body.work_folder,'custom-work');
  assert.throws(()=>runnerIntent('org/repo',{groupId:1,workFolder:'../escape'}));
});

test('command execution rejects an omitted timeout before starting a process',async()=>{
  await assert.rejects(commands.run('/does-not-exist',[],{cwd:process.cwd(),env:toolEnvironment()} as any),/Explicit command timeout/);
});

test('existing GitHub setup JSON retains its pre-refactor digest without inserted defaults',()=>{
  const s=setup();delete s.deployment.options;s.secrets=[{provider:'github',repository:'org/repo',key:'KEY'}];
  assert.equal(setupDigest(s),'sha256:fe5b0065aaafdebcc98decc995b880b51745617bfdfb308c61ee0ea826e4386a');
  assert.equal(Object.hasOwn(parseSetup(s).deployment,'options'),false);
});

test('storage adapter failure cannot disclose backend credentials or deliver unpersisted events',async()=>{
  let delivered=false;const c=createTelemetryCollector({setup:setup(),executionId:'run',attemptId:'attempt',openStore:()=>({
    async recordEvent(){throw Error('backend-auth-secret');},listEvents(){return [];},close(){}
  }),sinks:[{name:'sink',async publish(){delivered=true;return {sink:'sink',ok:true};}}]});
  try {await assert.rejects(c.publish({source:'agent',kind:'hook',eventType:'event',payload:{}}),error=>error instanceof Error&&error.message==='Telemetry storage failed');assert.equal(delivered,false);}finally{c.close();}
});
