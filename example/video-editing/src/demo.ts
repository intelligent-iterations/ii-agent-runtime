// npm run demo [-- --editor moviepy|remotion|hyperframes] [-- --config config.json]
// Builds the renderer and coordinator images on first use, then renders the project
// through the runtime from inside the Linux coordinator, on macOS or Linux alike.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configuration,ConfigurationError,type Editor} from './config.js';
import {coordinatorImage,rendererImage,SetupError,type Exec} from './images.js';

const EDITORS:Editor[]=['moviepy','remotion','hyperframes'];
const HELP=`npm run demo                         render the bundled sample with MoviePy
npm run demo -- --editor remotion    the same sample with Remotion (or hyperframes)
npm run demo -- --config config.json your own project; copy config.example.json first

Needs Node 22.16+ and Docker Desktop or Colima. The first run builds the images.`;

export interface DemoDependencies {
  exec:Exec;
  /** Runs the coordinator container with the terminal attached; returns its exit code. */
  attach:(args:string[])=>number;
  log:(line:string)=>void;
  platform:NodeJS.Platform;
  home:string;
  user:{uid:number;gid:number};
  now:()=>Date;
  /** The example folder holding config.example.json, sample/ and the Dockerfiles. */
  example?:string;
}

const exec:Exec=(command,args,options={})=>options.inherit
  ?(execFileSync(command,args,{cwd:options.cwd,stdio:'inherit'}),'')
  :execFileSync(command,args,{cwd:options.cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1048576});
const defaults:DemoDependencies={
  exec,
  attach:args=>{
    // Ctrl-C reaches the coordinator, which cancels the render and cleans up; wait for it.
    const ignore=()=>{};process.on('SIGINT',ignore);process.on('SIGTERM',ignore);
    try{return spawnSync('docker',args,{stdio:'inherit'}).status??1;}
    finally{process.off('SIGINT',ignore);process.off('SIGTERM',ignore);}
  },
  log:line=>console.log(line),
  platform:process.platform,
  home:homedir(),
  user:{uid:process.getuid?.()??0,gid:process.getgid?.()??0},
  now:()=>new Date(),
};

export function exampleDirectory():string {
  let directory=dirname(fileURLToPath(import.meta.url));
  while(!existsSync(join(directory,'config.example.json'))){
    const parent=dirname(directory);
    if(parent===directory)throw new SetupError('Run npm run demo from the video-editing example.');
    directory=parent;
  }
  return directory;
}

function parse(argv:string[]):{editor?:Editor;config?:string;help?:boolean} {
  const result:{editor?:Editor;config?:string;help?:boolean}={};
  for(let i=0;i<argv.length;i++){
    const [flag,value]=[argv[i],argv[i+1]];
    if(flag==='--help'||flag==='-h'){result.help=true;continue;}
    if(flag==='--editor'&&EDITORS.includes(value as Editor)){result.editor=value as Editor;i++;continue;}
    if(flag==='--config'&&value){result.config=value;i++;continue;}
    throw new ConfigurationError([flag==='--editor'?'--editor: choose moviepy, remotion or hyperframes.':`Unknown option ${flag}; see npm run demo -- --help.`]);
  }
  if(result.editor&&result.config)throw new ConfigurationError(['--editor applies to the bundled sample; set "editor" in your config instead.']);
  return result;
}

// Local time, as you'd read it on your clock.
const stamp=(date:Date)=>{const two=(n:number)=>String(n).padStart(2,'0');
  return `${date.getFullYear()}${two(date.getMonth()+1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;};

/** The run's configuration file, and whether the demo wrote it (the bundled sample) and should remove it. */
function prepareConfig(example:string,options:{editor?:Editor;config?:string},now:Date):{path:string;generated:boolean} {
  if(options.config){
    const path=resolve(options.config);
    if(!existsSync(path))throw new ConfigurationError([`config: ${path} does not exist; copy config.example.json first.`]);
    return {path,generated:false};
  }
  const value=JSON.parse(readFileSync(join(example,'config.example.json'),'utf8'));
  const editor:Editor=options.editor??value.editor;
  const name=`${editor}-${stamp(now)}`;
  mkdirSync(join(example,'results'),{recursive:true});
  const path=join(example,'results',`.${name}.json`);
  writeFileSync(path,JSON.stringify({...value,editor,project:'../sample',output:`./${name}`,
    inputs:['make-source.sh','shorts.json','captions.json',editor],command:['sh',`${editor}/render.sh`]},null,2)+'\n',{mode:0o600});
  return {path,generated:true};
}

/** Docker Desktop and Colima share only your home directory with their Linux VM by default. */
function shared(path:string,what:string,deps:DemoDependencies):string {
  const real=realpathSync(path);
  if(deps.platform!=='darwin')return real;
  const roots=[deps.home,...(process.env.DOCKER_SHARED_DIRS??'').split(':').filter(p=>isAbsolute(p)&&existsSync(p))].map(p=>realpathSync(p));
  if(roots.some(root=>real===root||real.startsWith(root+sep)))return real;
  throw new ConfigurationError([`${what} ${real} is outside your home directory. Docker Desktop and Colima share only your home `+
    `directory with their VM by default: move it under ${deps.home}, or add its directory to Docker's file sharing and to DOCKER_SHARED_DIRS.`]);
}

export async function runDemo(argv:string[],deps:DemoDependencies=defaults):Promise<number> {
  const options=parse(argv);
  if(options.help){deps.log(HELP);return 0;}
  const example=deps.example??exampleDirectory();
  const {path,generated}=prepareConfig(example,options,deps.now());
  try{
    const directory=dirname(path);
    let value:Record<string,unknown>;
    try{value=JSON.parse(readFileSync(path,'utf8'));}catch(error){throw new ConfigurationError([`config: ${path} is not valid JSON (${(error as Error).message}).`]);}
    // Check every setting before the slow image builds; the image is filled in below when omitted.
    const editor=EDITORS.includes(value.editor as Editor)?value.editor as Editor:'moviepy';
    const c=configuration(value,directory,{image:typeof value.image==='string'?value.image:`video-editing-${editor}@sha256:${'0'.repeat(64)}`});
    const problems:string[]=[];
    if(!existsSync(c.project))problems.push(`project: ${c.project} does not exist.`);
    if(existsSync(c.output))problems.push(`output: ${c.output} already exists; choose a new directory (results are never overwritten).`);
    else if(!existsSync(dirname(c.output)))problems.push(`output: create the parent directory ${dirname(c.output)} first.`);
    if(problems.length)throw new ConfigurationError(problems);
    try{deps.exec('docker',['version','--format','{{.Server.Version}}']);}
    catch{throw new SetupError('Docker is not answering. Start Docker Desktop or Colima, then run npm run demo again.');}
    const mounts=[...new Set([shared(directory,'The config directory',deps),shared(c.project,'The project',deps),shared(dirname(c.output),'The output directory',deps)])]
      .filter((p,_,all)=>!all.some(other=>other!==p&&(p.startsWith(other+sep))));
    const image=typeof value.image==='string'?undefined:rendererImage(deps.exec,example,editor,deps.log);
    const coordinator=coordinatorImage(deps.exec,example,deps.log);
    const shown=(p:string)=>{const r=relative(process.cwd(),p);
      return !r.startsWith('..')?r||'.':p===deps.home||p.startsWith(deps.home+sep)?'~/'+relative(deps.home,p):p;};
    deps.log(`Rendering ${shown(c.project)} with ${editor} in an offline worker (${c.cpu} CPUs, ${c.memoryMiB} MiB, ${c.timeoutSeconds}s limit)...`);
    // Same-path bind mounts: the runtime's helper containers resolve these paths on Docker's VM too.
    const bind=(p:string)=>`type=bind,"source=${p.replaceAll('"','""')}","target=${p.replaceAll('"','""')}"`;
    // Run as you, so results are yours and the runtime's private state passes its owner checks
    // on shared folders; the socket's group (as Docker's VM sees it) grants Docker access.
    const socket=['--volume','/var/run/docker.sock:/var/run/docker.sock'];
    const group=deps.exec('docker',['run','--rm',...socket,'--entrypoint','stat',coordinator,'-c','%g','/var/run/docker.sock']).trim();
    const status=deps.attach(['run','--rm','--init',...socket,'--user',`${deps.user.uid}:${deps.user.gid}`,'--group-add',group,'--env','HOME=/tmp',
      ...mounts.flatMap(p=>['--mount',bind(p)]),'--workdir',realpathSync(directory),coordinator,
      '--config',join(realpathSync(directory),basename(path)),...(image?['--image',image]:[])]);
    const recordPath=join(c.output,'run.json');
    if(!existsSync(recordPath))return status||1;
    const record=JSON.parse(readFileSync(recordPath,'utf8')) as {runId?:string;status:string;cleanup:string;error?:string;artifact?:{file:string;bytes:number;sha256:string};media?:{videos:{file:string}[]}};
    if(status!==0||record.status!=='passed'||record.cleanup!=='confirmed'){
      deps.log(`The render failed: ${(record.error??'see run.json').replace(/\.$/,'')}. Cleanup ${record.cleanup}. Details: ${shown(c.output)}/command.log and run.json.`);
      return 1;
    }
    // Verify the coordinator's delivered bytes before handing an archive to tar.
    const archive=join(c.output,'videos.tar');
    const artifact=record.artifact;
    if(!artifact||artifact.file!=='videos.tar'||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1||
      artifact.bytes>c.maxOutputMiB*1048576+1048576||!/^[a-f0-9]{64}$/.test(artifact.sha256))
      throw new SetupError('The export has no valid archive proof; retain run.json and render again.');
    const info=lstatSync(archive);
    if(!info.isFile()||info.nlink!==1||info.size!==artifact.bytes)
      throw new SetupError('The exported archive changed; retain run.json and render again.');
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of createReadStream(archive)){
      bytes+=chunk.length;
      if(bytes>artifact.bytes)throw new SetupError('The exported archive changed; retain run.json and render again.');
      hash.update(chunk);
    }
    if(bytes!==artifact.bytes||hash.digest('hex')!==artifact.sha256)
      throw new SetupError('The exported archive hash does not match run.json; render again.');
    // The coordinator rebuilt this archive from validated, uniquely named regular MP4s only.
    const videos=join(c.output,'videos');mkdirSync(videos);
    deps.exec('tar',['-xmf',archive,'-C',videos]);
    const count=record.media?.videos.length??0;
    deps.log(`Rendered ${count} portrait ${count===1?'short':'shorts'} with ${editor}; validation passed and cleanup was confirmed (run ${record.runId}).`);
    for(const video of record.media?.videos??[])deps.log('  '+shown(join(videos,video.file)));
    deps.log(`Run record: ${shown(recordPath)}`);
    return 0;
  }finally{if(generated)rmSync(path,{force:true});}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1])){
  runDemo(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{
    console.error(error instanceof ConfigurationError||error instanceof SetupError?error.message:
      'The demo stopped unexpectedly. Check that Docker is running, then try again.');
    process.exitCode=1;
  });
}
