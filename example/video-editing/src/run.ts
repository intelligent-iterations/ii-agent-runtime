import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream,createWriteStream,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {dockerTofuTarget,executionServices,type ExecutionTarget,type DockerTargetCheckpoint} from '@intelligent-iterations/ii-agent-runtime/pipeline';
import {ConfigurationError,type Configuration} from './config.js';
import {stageInput} from './input.js';

interface Video {file:string;bytes:number;sha256:string;width?:number;height?:number;duration_s?:number;audio?:boolean;full_decode?:string}
export interface RunRecord {
  runId:string;phase:string;editor:string;status:'started'|'passed'|'failed';cleanup:'pending'|'confirmed'|'failed';
  configuration:Configuration;inputs:Record<string,{bytes:number;sha256:string}>;checkpoints:DockerTargetCheckpoint[];
  startedAt:string;finishedAt?:string;artifact?:{file:string;bytes:number;sha256:string};
  media?:{videos:Video[];archive_bytes:number};error?:string;
}
const outcome=(text:string):Record<string,unknown>=>{
  try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}
};
const videos=(n:number)=>n===1?'1 MP4':`${n} MP4s`;
// The renderer worker ran project code, so only known codes and integers are used from its output.
function collectionProblem(result:Record<string,unknown>,c:Configuration):string {
  const found=result.found;
  switch(result.error){
    case 'no-out':return 'Your command must write its videos into an out/ folder at the project root; create it first, for example with mkdir -p out.';
    case 'too-few':return Number.isSafeInteger(found)?`Your command wrote ${videos(found as number)} to out/, but expectedVideos is ${c.expectedVideos}.`:'Video collection failed';
    case 'too-many':return `Your command wrote more than ${videos(c.expectedVideos)} to out/; set expectedVideos to the number it writes.`;
    case 'not-regular':return 'The MP4s in out/ must be regular files, not links or folders.';
    case 'too-large':return `The MP4s in out/ are larger than maxOutputMiB (${c.maxOutputMiB} MiB) in total.`;
    default:return 'Video collection failed';
  }
}
// The validator never runs project code; file names are still checked against the accepted set.
function validationProblem(result:Record<string,unknown>,accepted:string[],c:Configuration):string {
  const file=typeof result.file==='string'&&accepted.includes(result.file)?result.file:'A video';
  const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
  const [width,height,seconds]=[number(result.width),number(result.height),number(result.seconds)];
  switch(result.error){
    case 'landscape':return `${file} is ${width}×${height}; videos must be portrait (taller than wide), for example 1080×1920.`;
    case 'no-audio':return `${file} has no audio stream; add one, even silence.`;
    case 'duration':return `${file} lasts ${seconds} seconds; each video must last more than 0 and at most 180 seconds.`;
    case 'no-video':return `${file} has no video stream.`;
    case 'unreadable':return `${file} is not a readable video file.`;
    case 'decode':return `${file} failed a full FFmpeg decode; re-encode it, for example as H.264 with AAC audio.`;
    case 'too-large':return `The videos are larger than maxOutputMiB (${c.maxOutputMiB} MiB) in total.`;
    default:return 'Invalid export proof';
  }
}
export type TargetFactory=(options:Parameters<typeof dockerTofuTarget>[0])=>ExecutionTarget;
const execute=promisify(execFile);

export async function renderProject(
  c:Configuration,targetFactory:TargetFactory=dockerTofuTarget,signal:AbortSignal=new AbortController().signal,
):Promise<RunRecord> {
  const stage=mkdtempSync(join(tmpdir(),'video-project-'));
  const deadlineMs=Date.now()+c.timeoutSeconds*1000;
  const budget=(maximum:number)=>{
    signal.throwIfAborted();
    const remaining=deadlineMs-Date.now()-30000;
    if(remaining<1000)throw Error('Render deadline reached; increase timeoutSeconds.');
    return Math.min(maximum,remaining);
  };
  let record:RunRecord|undefined,target:ExecutionTarget|undefined;
  const partial=join(c.output,'videos.tar.part');
  const save=()=>{if(record)writeFileSync(join(c.output,'run.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});};
  try {
    const input=join(stage,'input');mkdirSync(input,{mode:0o700});
    const inputs=await stageInput(c,input,{deadlineMs:Math.min(deadlineMs-30000,Date.now()+30000),signal});
    try{mkdirSync(c.output,{mode:0o700});}
    catch{throw new ConfigurationError(['output: choose a new directory with an existing writable parent; existing results are never overwritten.']);}
    const parent=join(c.output,'runtime-state');mkdirSync(parent,{mode:0o700});
    record={runId:randomUUID(),phase:'provisioning',editor:c.editor,status:'started',cleanup:'pending',configuration:c,inputs,checkpoints:[],startedAt:new Date().toISOString()};save();
    const provision=async(role:string)=>{
      budget(1000);
      target=targetFactory({parent,executablePath:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',services:executionServices,
        workspaceHelperImage:c.workspaceHelperImage??c.image,
        checkpoint:async value=>{record!.checkpoints.push(value);save();}});
      return target.provision({image:c.image,cpu:c.cpu,memoryMiB:c.memoryMiB,diskGiB:c.diskGiB,timeoutSeconds:c.timeoutSeconds,
        configurationDigest:'sha256:'+createHash('sha256').update(JSON.stringify({role,configuration:c,inputs})).digest('hex')},{deadlineMs,signal});
    };
    const worker=await provision('renderer');
    record.phase='loading';save();
    await worker.load(input);
    // Both workers remain offline throughout their lifetimes.
    await worker.run({command:'python3',args:['-I','-c',"from pathlib import Path;[Path('/workspace/'+p).mkdir(exist_ok=True) for p in ['tmp','home']]"],timeoutMs:budget(10000),maxOutputBytes:1024,signal});
    record.phase='rendering';save();
    const launcher=readFileSync(new URL('./render.py',import.meta.url),'utf8');
    const rendered=JSON.parse(await worker.run({command:'python3',args:['-I','-c',launcher,...c.command],timeoutMs:budget((c.timeoutSeconds-Math.min(300,c.timeoutSeconds/3))*1000),maxOutputBytes:1024,signal})) as {exit_code?:number};
    const log=await worker.run({command:'cat',args:['/workspace/render.log'],timeoutMs:budget(10000),maxOutputBytes:1048576,signal});
    writeFileSync(join(c.output,'command.log'),log,{mode:0o600});
    if(rendered.exit_code!==0)throw Error('Editor command failed; see command.log.');
    record.phase='collecting';save();
    const collect=readFileSync(new URL('./collect.py',import.meta.url),'utf8');
    const collected=outcome(await worker.run({command:'python3',args:['-I','-c',collect,String(c.maxOutputMiB*1048576),String(c.expectedVideos)],timeoutMs:budget(30000),maxOutputBytes:32768,signal}));
    if(collected.ok!==true)throw Error(collectionProblem(collected,c));
    if(!worker.open)throw Error('Execution target does not support bounded output streaming');
    const cap=c.maxOutputMiB*1048576+1048576;
    const session=await worker.open({command:'cat',args:['/workspace/candidates.tar'],timeoutMs:budget(120000),maxInputBytes:1,maxOutputBytes:cap,signal});
    const candidate=join(stage,'candidate.tar');let received=0;
    try {
      session.end();
      const meter=new Transform({transform(chunk:Buffer,_encoding,callback){
        received+=chunk.length;
        if(received>cap){callback(Error('Export exceeds size limit'));return;}
        callback(null,chunk);
      }});
      const completion=session.completion.then(result=>({result}),error=>({error}));
      await pipeline(Readable.from(session.output),meter,createWriteStream(candidate,{flags:'wx',mode:0o600}),{signal});
      const finished=await completion;
      if('error' in finished)throw finished.error;
      if(finished.result.exitCode!==0)throw Error('Video export failed');
    }finally{await session.close();}
    // Remove the renderer and every surviving project process before validating.
    await target!.close();target=undefined;
    record.phase='validation';save();
    const clean=join(stage,'validation');
    let accepted:{videos:Video[];archive_bytes:number};
    try{
      const {stdout}=await execute('python3',['-I',fileURLToPath(new URL('./archive.py',import.meta.url)),candidate,clean,partial,String(c.maxOutputMiB*1048576),String(c.expectedVideos)],
        {cwd:stage,timeout:budget(30000),maxBuffer:65536,killSignal:'SIGKILL',signal});
      accepted=JSON.parse(stdout);
    }catch{throw Error('Unsafe or invalid candidate archive');}
    // Only coordinator-approved regular MP4 bytes enter a new worker. No scripts,
    // Python modules, renderer state or renderer processes cross this boundary.
    const validator=await provision('validator');await validator.load(clean);
    const script=readFileSync(new URL('./export.py',import.meta.url),'utf8');
    const proof=outcome(await validator.run({command:'python3',args:['-I','-c',script,String(c.maxOutputMiB*1048576),String(c.expectedVideos)],timeoutMs:budget(150000),maxOutputBytes:65536,signal})) as {videos?:Video[];error?:unknown};
    if(typeof proof.error==='string')throw Error(validationProblem(proof,accepted.videos.map(v=>v.file),c));
    if(!Array.isArray(proof.videos)||proof.videos.length!==accepted.videos.length)throw Error('Invalid export proof');
    for(const expected of accepted.videos){
      const matches=proof.videos.filter(v=>v?.file===expected.file);const v=matches[0];
      if(matches.length!==1||v.bytes!==expected.bytes||v.sha256!==expected.sha256||
        typeof v.width!=='number'||typeof v.height!=='number'||!Number.isSafeInteger(v.width)||!Number.isSafeInteger(v.height)||v.width<=0||v.height<=v.width||
        typeof v.duration_s!=='number'||!Number.isFinite(v.duration_s)||v.duration_s<=0||v.duration_s>180||v.audio!==true||v.full_decode!=='passed')throw Error('Invalid export proof');
    }
    record.media={videos:proof.videos!,archive_bytes:accepted.archive_bytes};
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of createReadStream(partial)){budget(1000);bytes+=chunk.length;hash.update(chunk);}
    if(bytes!==accepted.archive_bytes)throw Error('Video export failed');
    renameSync(partial,join(c.output,'videos.tar'));
    record.artifact={file:'videos.tar',bytes,sha256:hash.digest('hex')};record.status='passed';record.phase='complete';
  }catch(error){
    if(!record)throw error;
    record.status='failed';record.error=signal.aborted?'Render cancelled':error instanceof Error?error.message:'Video render failed';
  }finally{
    try{await target?.close();if(record)record.cleanup='confirmed';}
    catch{if(record){record.cleanup='failed';record.status='failed';record.error='Runtime cleanup failed; retain run.json and runtime-state for recovery';}}
    // Do not touch a pre-existing output directory when configuration/staging failed.
    if(record)rmSync(partial,{force:true});
    rmSync(stage,{recursive:true,force:true});
    if(record){record.finishedAt=new Date().toISOString();save();}
  }
  return record!;
}
