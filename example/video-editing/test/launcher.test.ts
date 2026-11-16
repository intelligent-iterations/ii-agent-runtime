// npm run demo's own code with Docker intercepted: image builds, the coordinator
// container and its arguments, result extraction and setup errors. No Docker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {configuration,ConfigurationError,type Editor} from '../src/config.js';
import {stageInput} from '../src/input.js';
import {exampleDirectory,runDemo,type DemoDependencies} from '../src/demo.js';
import {SetupError,type Exec} from '../src/images.js';
import {tarBuffer} from './helpers.js';

const source=exampleDirectory();
const digest='sha256:'+'b'.repeat(64);
const now=new Date('2026-11-16T04:30:00Z');
// Result folders are named in local time.
const two=(n:number)=>String(n).padStart(2,'0');
const stamp=`${now.getFullYear()}${two(now.getMonth()+1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;

function workspace(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'video-launcher-')));
  const example=join(root,'video-editing');
  for(const name of ['config.example.json','sample','images','coordinator','package.json','package-lock.json','tsconfig.json','src','scripts'])
    cpSync(join(source,name),join(example,name),{recursive:true});
  return {root,example,close:()=>rmSync(root,{recursive:true,force:true})};
}
type Call={command:string;args:string[]};
function docker(options:{images?:string[];digests?:string[]|null;daemon?:boolean;status?:'passed'|'failed';exitCode?:number;cleanup?:string;corruptArchive?:boolean}={}){
  const calls:Call[]=[],attached:string[][]=[],logs:string[]=[];
  const present=new Set(options.images??[]);
  const exec:Exec=(command,args)=>{
    calls.push({command,args});
    if(command==='tar')return execFileSync('tar',args,{encoding:'utf8'});
    if(command==='npm'){const dir=args[args.indexOf('--pack-destination')+1];writeFileSync(join(dir,'runtime-0.1.0.tgz'),'packed runtime');return JSON.stringify([{filename:'runtime-0.1.0.tgz'}]);}
    if(args[0]==='version'){if(options.daemon===false)throw Error('no daemon');return '29.2.1';}
    if(args[0]==='build'){present.add(args[args.indexOf('--tag')+1]);return '';}
    if(args[0]==='image'&&args.includes('{{.Id}}')){if(!present.has(args.at(-1)!))throw Error('missing');return 'sha256:id';}
    if(args[0]==='image'&&args.includes('{{json .RepoDigests}}')){const image=args.at(-1)!;return JSON.stringify(options.digests===undefined?[image.split(':')[0]+'@'+digest]:options.digests);}
    if(args[0]==='run'&&args.includes('stat'))return '991\n';
    throw Error('unexpected docker '+args.join(' '));
  };
  // Plays the coordinator: reads the mounted config and writes a run record and archive.
  const attach=(args:string[])=>{
    attached.push(args);
    const path=args[args.indexOf('--config')+1],c=JSON.parse(readFileSync(path,'utf8'));
    const output=join(dirname(path),c.output);mkdirSync(output);
    const videos=['short-1.mp4','short-2.mp4'].map(file=>({file,data:Buffer.from('video '+file)}));
    const archive=tarBuffer(videos.map(v=>({name:v.file,data:v.data})));
    writeFileSync(join(output,'videos.tar'),options.corruptArchive?Buffer.alloc(archive.length):archive);
    writeFileSync(join(output,'run.json'),JSON.stringify({runId:'run-1',status:options.status??'passed',cleanup:options.cleanup??'confirmed',error:options.status==='failed'?'Editor command failed; see command.log.':undefined,
      artifact:{file:'videos.tar',bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')},
      media:{videos:videos.map(v=>({file:v.file,sha256:createHash('sha256').update(v.data).digest('hex')}))}}));
    return options.exitCode??(options.status==='failed'?1:0);
  };
  return {calls,attached,logs,deps:(example:string,home:string,platform:NodeJS.Platform='darwin'):DemoDependencies=>
    ({exec,attach,log:line=>logs.push(line),platform,home,user:{uid:501,gid:20},now:()=>now,example})};
}

test('the bundled sample config works as copied and stages each editor project',async()=>{
  const value=JSON.parse(readFileSync(join(source,'config.example.json'),'utf8'));
  const c=configuration(value,source,{image:'video-editing-moviepy@'+digest});
  assert.equal(c.project,join(source,'sample'));
  for(const editor of ['moviepy','remotion','hyperframes'] as Editor[]){
    const stage=mkdtempSync(join(tmpdir(),'video-sample-'));
    try{
      const files=await stageInput({...c,editor,inputs:['make-source.sh','shorts.json','captions.json',editor]},stage);
      assert.ok(files[`${editor}/render.sh`]&&files['make-source.sh']&&files['captions.json'],editor);
      assert.ok(!Object.keys(files).some(name=>name.includes('node_modules')||name.endsWith('.mp4')),'the sample ships no media or packages');
    }finally{rmSync(stage,{recursive:true,force:true});}
  }
});

test('npm run demo builds the images once and runs the sample in the coordinator as you',async()=>{
  const w=workspace(),d=docker();try{
    assert.equal(await runDemo(['--editor','remotion'],d.deps(w.example,w.root)),0);
    const builds=d.calls.filter(c=>c.args[0]==='build');
    assert.equal(builds.length,2);
    assert.deepEqual(builds[0].args.slice(1,3),['--target','remotion']);
    const args=d.attached[0];
    assert.deepEqual(args.slice(args.indexOf('--user'),args.indexOf('--user')+4),['--user','501:20','--group-add','991']);
    assert.ok(args.includes('/var/run/docker.sock:/var/run/docker.sock'));
    assert.match(args[args.indexOf('--image')+1],/^video-editing-remotion@sha256:b{64}$/);
    const mounts=args.flatMap((a,i)=>a==='--mount'?[args[i+1]]:[]);
    assert.ok(mounts.some(m=>m.includes(join(w.example,'results'))&&m.includes('"target='+join(w.example,'results')+'"')),'same-path results mount');
    assert.ok(mounts.some(m=>m.includes(join(w.example,'sample'))),'the sample is mounted');
    const run=join(w.example,'results',`remotion-${stamp}`);
    assert.deepEqual(readdirSync(join(run,'videos')).sort(),['short-1.mp4','short-2.mp4']);
    assert.ok(!readdirSync(join(w.example,'results')).some(name=>name.startsWith('.')),'the generated config is removed');
    assert.ok(d.logs.some(l=>l.includes('Rendered 2 portrait shorts with remotion')));
    // A second run reuses both images.
    await runDemo(['--editor','remotion'],{...d.deps(w.example,w.root),now:()=>new Date('2026-11-16T05:00:00Z')});
    assert.equal(d.calls.filter(c=>c.args[0]==='build').length,2);
  }finally{w.close();}
});

test('a config with an image skips the renderer build; problems are listed together',async()=>{
  const w=workspace(),d=docker();try{
    const project=join(w.root,'mine');mkdirSync(project);mkdirSync(join(w.root,'taken'));
    const config=join(w.root,'config.json');
    writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(join(w.example,'config.example.json'),'utf8')),project:'./mine',output:'./taken',image:'registry.example/mine@'+digest,cpu:99}));
    await assert.rejects(runDemo(['--config',config],d.deps(w.example,w.root)),(e:Error)=>e instanceof ConfigurationError&&/cpu:/.test(e.message)&&!/output/.test(e.message));
    writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(config,'utf8')),cpu:2}));
    await assert.rejects(runDemo(['--config',config],d.deps(w.example,w.root)),/output: .*taken already exists/);
    writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(config,'utf8')),output:'./new'}));
    assert.equal(await runDemo(['--config',config],d.deps(w.example,w.root)),0);
    assert.ok(!d.calls.some(c=>c.args.includes('--target')));
    assert.ok(!d.attached[0].includes('--image'));
  }finally{w.close();}
});

test('setup mistakes are named in plain words before anything runs',async()=>{
  const w=workspace();try{
    mkdirSync(join(w.root,'elsewhere'));
    await assert.rejects(runDemo(['--editor','premiere'],docker().deps(w.example,w.root)),/--editor: choose moviepy, remotion or hyperframes/);
    await assert.rejects(runDemo(['--editor','moviepy','--config','x.json'],docker().deps(w.example,w.root)),/set "editor" in your config/);
    await assert.rejects(runDemo([],docker({daemon:false}).deps(w.example,w.root)),(e:Error)=>e instanceof SetupError&&/Start Docker Desktop or Colima/.test(e.message));
    await assert.rejects(runDemo([],docker({digests:[]}).deps(w.example,w.root)),/containerd image store/);
    await assert.rejects(runDemo([],docker().deps(w.example,join(w.root,'elsewhere'))),/outside your home directory/);
    const d=docker();assert.equal(await runDemo([],d.deps(w.example,join(w.root,'elsewhere'),'linux')),0,'Linux has no shared-folder limit');
    const help=docker();assert.equal(await runDemo(['--help'],help.deps(w.example,w.root)),0);assert.match(help.logs[0],/npm run demo -- --editor remotion/);
  }finally{w.close();}
});

test('a failed render reports where to look and exits 1',async()=>{
  const w=workspace(),d=docker({status:'failed'});try{
    assert.equal(await runDemo([],d.deps(w.example,w.root)),1);
    assert.match(d.logs.at(-1)!,/The render failed: Editor command failed.*command\.log and run\.json/);
    assert.ok(!existsSync(join(w.example,'results',`moviepy-${stamp}`,'videos')));
  }finally{w.close();}
});

for(const options of [{exitCode:1},{cleanup:'failed'},{cleanup:'pending'}])
test('a passed record cannot override coordinator failure or incomplete cleanup '+JSON.stringify(options),async()=>{
  const w=workspace(),d=docker(options);try{
    assert.equal(await runDemo([],d.deps(w.example,w.root)),1);
    assert.ok(!d.calls.some(c=>c.command==='tar'));
    assert.ok(!existsSync(join(w.example,'results',`moviepy-${stamp}`,'videos')));
  }finally{w.close();}
});

test('a modified archive is rejected before extraction',async()=>{
  const w=workspace(),d=docker({corruptArchive:true});try{
    await assert.rejects(runDemo([],d.deps(w.example,w.root)),/archive hash does not match/);
    assert.ok(!d.calls.some(c=>c.command==='tar'));
    assert.ok(!existsSync(join(w.example,'results',`moviepy-${stamp}`,'videos')));
  }finally{w.close();}
});
