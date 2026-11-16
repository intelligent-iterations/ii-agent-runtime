import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageInput} from '../src/input.js';
import {configuration} from '../src/config.js';
import {tarBuffer} from './helpers.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'video-security-'));const project=join(root,'project');mkdirSync(project);
 const c=configuration({editor:'moviepy',image:'example.test/worker@sha256:'+'a'.repeat(64),project,inputs:['assets'],command:['render'],output:join(root,'result'),cpu:1,memoryMiB:256,diskGiB:1,timeoutSeconds:240,maxInputMiB:1,maxOutputMiB:1,expectedVideos:1},root);
 const stage=join(root,'stage');mkdirSync(stage);
 return {root,project,stage,c,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('staging bounds empty directory traversal',async()=>{
 const f=fixture();try{
  const assets=join(f.project,'assets');mkdirSync(assets);writeFileSync(join(assets,'one.txt'),'one');
  for(let i=0;i<4097;i++)mkdirSync(join(assets,'dir'+i));
  await assert.rejects(stageInput(f.c,f.stage),/4096 visited entries/);
 }finally{f.close();}
});
test('excluded entries consume the traversal budget',async()=>{
 const f=fixture();try{
  const assets=join(f.project,'assets');mkdirSync(assets);
  for(let i=0;i<4097;i++)writeFileSync(join(assets,'.hidden'+i),'');
  await assert.rejects(stageInput(f.c,f.stage),/4096 visited entries/);
 }finally{f.close();}
});
test('staging rejects excessive nesting',async()=>{
 const f=fixture();try{
  let directory=join(f.project,'assets');mkdirSync(directory);
  for(let i=0;i<34;i++){directory=join(directory,'nested');mkdirSync(directory);}
  await assert.rejects(stageInput(f.c,f.stage),/32 directory levels/);
 }finally{f.close();}
});
test('staging observes deadlines and cancellation before provisioning',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.project,'assets'));writeFileSync(join(f.project,'assets','video'),'data');
  await assert.rejects(stageInput(f.c,f.stage,{deadlineMs:Date.now()-1,signal:new AbortController().signal}),/staging deadline/);
  const abort=new AbortController();const pending=stageInput(f.c,f.stage,{deadlineMs:Date.now()+10000,signal:abort.signal});
  setImmediate(()=>abort.abort());await assert.rejects(pending,/abort/i);
 }finally{f.close();}
});
test('growing inputs cannot bypass the byte cap',async()=>{
 const f=fixture();let timer:NodeJS.Timeout|undefined;try{
  mkdirSync(join(f.project,'assets'));const source=join(f.project,'assets','large.bin');writeFileSync(source,Buffer.alloc(1048576));
  timer=setInterval(()=>writeFileSync(source,Buffer.alloc(65536),{flag:'a'}),1);
  await assert.rejects(stageInput(f.c,f.stage),/changed|maxInputMiB/);
  const staged=join(f.stage,'assets','large.bin');if(existsSync(staged))assert.ok(statSync(staged).size<=1048576);
 }finally{clearInterval(timer);f.close();}
});

const cases:[string,Parameters<typeof tarBuffer>[0]][]=[
 ['parent traversal',[{name:'../outside.mp4',data:Buffer.from('x')}]],
 ['absolute path',[{name:'/outside.mp4',data:Buffer.from('x')}]],
 ['nested member',[{name:'nested/short.mp4',data:Buffer.from('x')}]],
 ['Windows separator',[{name:'..\\outside.mp4',data:Buffer.from('x')}]],
 ['Python module',[{name:'json.py',data:Buffer.from('x')}]],
 ['symlink',[{name:'short.mp4',type:'2',link:'../outside'}]],
 ['hardlink',[{name:'short.mp4',type:'1',link:'../outside'}]],
 ['directory',[{name:'short.mp4',type:'5'}]],
 ['oversized member',[{name:'short.mp4',size:1048577}]],
 ['empty video',[{name:'short.mp4'}]],
 ['duplicate name',[{name:'short.mp4',data:Buffer.from('a')},{name:'short.mp4',data:Buffer.from('b')}]],
 ['case collision',[{name:'Short.mp4',data:Buffer.from('a')},{name:'short.mp4',data:Buffer.from('b')}]],
];
for(const [name,entries] of cases)test('archive boundary rejects '+name,()=>{
 const f=fixture();try{
  const source=join(f.root,'candidate.tar');writeFileSync(source,tarBuffer(entries));
  const result=spawnSync('python3',['-I',fileURLToPath(new URL('../src/archive.py',import.meta.url)),source,join(f.root,'clean'),join(f.root,'result.tar'),'1048576',name.includes('duplicate')||name.includes('collision')?'2':'1'],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);assert.ok(!existsSync(join(f.root,'result.tar')));assert.ok(!existsSync(join(f.root,'outside.mp4')));
 }finally{f.close();}
});
test('archive rebuilding drops metadata and ignores workspace Python modules',()=>{
 const f=fixture();try{
  const source=join(f.root,'candidate.tar');writeFileSync(source,tarBuffer([{name:'short.mp4',data:Buffer.from('video')}]))
  writeFileSync(join(f.root,'json.py'),"raise RuntimeError('workspace module loaded')\n");
  const stdout=execFileSync('python3',['-I',fileURLToPath(new URL('../src/archive.py',import.meta.url)),source,join(f.root,'clean'),join(f.root,'result.tar'),'1048576','1'],{cwd:f.root,encoding:'utf8',timeout:10000});
  const proof=JSON.parse(stdout);assert.equal(proof.videos[0].file,'short.mp4');assert.equal(proof.videos[0].bytes,5);
  assert.equal(readFileSync(join(f.root,'clean','out','short.mp4'),'utf8'),'video');
  assert.ok(existsSync(join(f.root,'result.tar')));
 }finally{f.close();}
});
test('MP4 validation runs with isolated imports even in a poisoned workspace',()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'json.py'),"import os\nopen('bypassed','w').write('yes')\nos._exit(0)\n");
  const source=readFileSync(new URL('../src/export.py',import.meta.url),'utf8').replace("Path('/workspace/repository/out')",'Path(sys.argv[3])');
  const result=spawnSync('python3',['-I','-c',source,'1048576','1',join(f.root,'missing')],{cwd:f.root,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{error:'no-out'});assert.ok(!existsSync(join(f.root,'bypassed')));
 }finally{f.close();}
});
