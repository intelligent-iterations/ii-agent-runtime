import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExecutionTarget,Worker,WorkerResources} from '@intelligent-iterations/ii-agent-runtime/pipeline';
import {configuration,ConfigurationError} from '../src/config.js';
import {stageInput} from '../src/input.js';
import {renderProject,type TargetFactory} from '../src/run.js';
import {tarBuffer} from './helpers.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'video-test-'));
  mkdirSync(join(root,'project'));writeFileSync(join(root,'project','source.mp4'),'input');
  const value={editor:'moviepy',image:'example.test/moviepy@sha256:'+'a'.repeat(64),project:'project',inputs:['source.mp4'],command:['render','--all'],output:'result',cpu:1,memoryMiB:1024,diskGiB:2,timeoutSeconds:600,maxInputMiB:1,maxOutputMiB:1,expectedVideos:1};
  return {root,value,c:configuration(value,root),close:()=>rmSync(root,{recursive:true,force:true})};
}
function target(options:{renderFailure?:boolean;cleanupFailure?:boolean;stream?:Buffer;abort?:AbortController;proof?:unknown;collected?:unknown}={}){
  let closed=0,sessionClosed=0,requested:WorkerResources|undefined;
  const video=Buffer.from('video fixture');
  const data=tarBuffer([{name:'short.mp4',data:video}]);
  const proof={videos:[{file:'short.mp4',bytes:video.length,sha256:createHash('sha256').update(video).digest('hex'),width:16,height:32,duration_s:1,audio:true,full_decode:'passed'}]};
  let provisioned=0;
  const worker:Worker={workspace:'/workspace/repository',
    async load(path){
      if(provisioned===1)assert.equal(readFileSync(join(path,'source.mp4'),'utf8'),'input');
      else {assert.equal(readFileSync(join(path,'out','short.mp4'),'utf8'),'video fixture');assert.deepEqual(readdirSync(path),['out']);}
    },
    async run(request){
      if(request.command==='python3'&&request.args[3]==='render'){
        options.abort?.abort();request.signal?.throwIfAborted();
        return JSON.stringify({exit_code:options.renderFailure?1:0});
      }
      if(request.command==='cat'&&request.args[0]==='/workspace/render.log')return 'renderer output';
      if(request.command==='python3'&&request.args[2].includes('full_decode'))return JSON.stringify(options.proof??proof);
      if(request.command==='python3'&&request.args[2].includes('candidates.tar'))return JSON.stringify(options.collected??{ok:true});
      return '';
    },
    async open(){return {output:(async function*(){yield options.stream??data;})(),completion:Promise.resolve({exitCode:0}),write:async()=>{},end(){},async close(){sessionClosed++;}};},
    async setup(){throw Error('offline execution must not set up network access');},
    async isolate(){throw Error('offline execution must retain provisioned network=none');},
  };
  const execution:ExecutionTarget={async provision(resources,context){assert.ok(context?.signal);assert.equal(closed,provisioned);requested=resources;provisioned++;return worker;},async close(){closed++;if(options.cleanupFailure)throw Error('cleanup');}};
  const factory:TargetFactory=()=>execution;
  return {factory,data,get closed(){return closed;},get sessionClosed(){return sessionClosed;},get requested(){return requested;}};
}

test('configuration reports all settings to correct',()=>{
  assert.throws(()=>configuration({image:'latest',cpu:99,unexpected:true},'/tmp'),error=>error instanceof ConfigurationError&&error.problems.length>=10&&error.message.includes('image:')&&error.message.includes('cpu:'));
});
test('inputs exclude hidden and common key files and reject symlinks',async()=>{
  const f=fixture();try{
    const p=join(f.root,'project');mkdirSync(join(p,'assets'));mkdirSync(join(p,'assets','.private'));
    writeFileSync(join(p,'assets','render.py'),'safe');writeFileSync(join(p,'assets','secret.key'),'private');writeFileSync(join(p,'assets','.private','token'),'private');
    const dest=join(f.root,'stage');mkdirSync(dest);
    const result=await stageInput({...f.c,inputs:['assets']},dest);
    assert.deepEqual(Object.keys(result),['assets/render.py']);
    symlinkSync('render.py',join(p,'assets','linked.py'));
    await assert.rejects(stageInput({...f.c,inputs:['assets/linked.py']},dest),/symbolic links/);
  }finally{f.close();}
});
test('input byte limit fails before provisioning',async()=>{
  const f=fixture();const t=target();try{
    writeFileSync(join(f.root,'project','source.mp4'),Buffer.alloc(1048577));
    await assert.rejects(renderProject(f.c,t.factory),/maxInputMiB/);assert.equal(t.requested,undefined);
  }finally{f.close();}
});
for(const editor of ['hyperframes','remotion','moviepy'] as const)test(editor+': production runner exports hashes and closes the target',async()=>{
  const f=fixture(),t=target();try{
    const result=await renderProject({...f.c,editor},t.factory);
    assert.equal(result.status,'passed');assert.equal(result.cleanup,'confirmed');assert.equal(t.closed,2);assert.equal(t.sessionClosed,1);
    assert.equal(t.requested?.diskGiB,2);assert.equal(t.requested?.image,f.c.image);
    assert.equal(result.artifact?.sha256,createHash('sha256').update(readFileSync(join(f.c.output,'videos.tar'))).digest('hex'));
    assert.ok(readFileSync(join(f.c.output,'videos.tar')).includes(Buffer.from('video fixture')));
    assert.equal(JSON.parse(readFileSync(join(f.c.output,'run.json'),'utf8')).status,'passed');
  }finally{f.close();}
});
test('editor failure retains record and still cleans up',async()=>{
  const f=fixture(),t=target({renderFailure:true});try{
    const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.equal(result.cleanup,'confirmed');assert.equal(t.closed,1);assert.ok(!existsSync(join(f.c.output,'videos.tar')));
  }finally{f.close();}
});
test('oversized export deletes the partial file and closes transport',async()=>{
  const f=fixture(),t=target({stream:Buffer.alloc(2*1048576+1)});try{
    const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.equal(t.closed,1);assert.equal(t.sessionClosed,1);
    assert.ok(!existsSync(join(f.c.output,'videos.tar.part')));assert.ok(!existsSync(join(f.c.output,'videos.tar')));
  }finally{f.close();}
});
test('cleanup failure fails the run',async()=>{
  const f=fixture(),t=target({cleanupFailure:true});try{
    const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.equal(result.cleanup,'failed');assert.match(result.error!,/retain run.json/);
  }finally{f.close();}
});
test('cancellation reaches commands and cleanup',async()=>{
  const f=fixture(),abort=new AbortController(),t=target({abort});try{
    const result=await renderProject(f.c,t.factory,abort.signal);assert.equal(result.status,'failed');assert.equal(result.error,'Render cancelled');assert.equal(t.closed,1);
  }finally{f.close();}
});
test('existing outputs are preserved',async()=>{
  const f=fixture(),t=target();try{
    mkdirSync(f.c.output);writeFileSync(join(f.c.output,'keep'),'previous');
    await assert.rejects(renderProject(f.c,t.factory),/output: choose a new directory/);assert.equal(t.requested,undefined);assert.equal(readFileSync(join(f.c.output,'keep'),'utf8'),'previous');
  }finally{f.close();}
});

test('hostile renderer archive fails before a validator is provisioned',async()=>{
 const f=fixture(),t=target({stream:tarBuffer([{name:'../outside.mp4',data:Buffer.from('x')}])});try{
  const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.equal(result.cleanup,'confirmed');
  assert.match(result.error!,/Unsafe or invalid candidate archive/);assert.equal(t.closed,1);assert.ok(!existsSync(join(f.c.output,'videos.tar')));
 }finally{f.close();}
});
test('validator proof must match coordinator-owned video hashes',async()=>{
 const f=fixture(),t=target({proof:{videos:[{file:'short.mp4',bytes:13,sha256:'0'.repeat(64),width:16,height:32,duration_s:1,audio:true,full_decode:'passed'}]}});try{
  const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.match(result.error!,/Invalid export proof/);
  assert.equal(t.closed,2);assert.ok(!existsSync(join(f.c.output,'videos.tar')));assert.ok(!existsSync(join(f.c.output,'videos.tar.part')));
 }finally{f.close();}
});

test('project filenames cannot collide with coordinator temporary files',async()=>{
 const f=fixture(),t=target();try{
  writeFileSync(join(f.c.project,'candidate.tar'),'input');mkdirSync(join(f.c.project,'validation'));
  writeFileSync(join(f.c.project,'validation','notes.txt'),'input');
  const result=await renderProject({...f.c,inputs:['source.mp4','candidate.tar','validation']},t.factory);
  assert.equal(result.status,'passed');assert.equal(result.cleanup,'confirmed');
 }finally{f.close();}
});

test('collection problems name the fix without echoing renderer output',async()=>{
 for(const [collected,expected] of [
  [{error:'too-few',found:1},/wrote 1 MP4 to out\/, but expectedVideos is 1/],
  [{error:'no-out'},/out\/ folder at the project root/],
  [{error:'too-few',found:'<script>'},/^Video collection failed$/],
  [{error:'anything else',message:'renderer-controlled text'},/^Video collection failed$/],
 ] as [unknown,RegExp][]){
  const f=fixture(),t=target({collected});try{
   const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.match(result.error!,expected);
   assert.equal(result.cleanup,'confirmed');assert.equal(t.closed,1);
  }finally{f.close();}
 }
});
test('validation problems say which video failed which check',async()=>{
 for(const [proof,expected] of [
  [{error:'landscape',file:'short.mp4',width:1280,height:720},/^short\.mp4 is 1280×720; videos must be portrait/],
  [{error:'no-audio',file:'short.mp4'},/^short\.mp4 has no audio stream/],
  [{error:'duration',file:'../x.mp4',seconds:200},/^A video lasts 200 seconds/],
 ] as [unknown,RegExp][]){
  const f=fixture(),t=target({proof});try{
   const result=await renderProject(f.c,t.factory);assert.equal(result.status,'failed');assert.match(result.error!,expected);
   assert.equal(t.closed,2);assert.ok(!existsSync(join(f.c.output,'videos.tar')));
  }finally{f.close();}
 }
});
