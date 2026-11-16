// Builds the images `npm run demo` needs, once per content hash, with your Docker daemon.
// Docker builds run in Docker's Linux VM; no account settings are copied into an image.
import {createHash} from 'node:crypto';
import {cpSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bindRuntime} from '../scripts/packaging.mjs';
import type {Editor} from './config.js';

export const RUNTIME='@intelligent-iterations/ii-agent-runtime';
/** Runs docker, npm or tar and returns stdout; inherit=true streams output to the terminal instead. */
export type Exec=(command:'docker'|'npm'|'tar',args:string[],options?:{cwd?:string;inherit?:boolean})=>string;
export class SetupError extends Error {}

const hash=(...parts:(string|Buffer)[])=>{const h=createHash('sha256');for(const p of parts)h.update(p);return h.digest('hex').slice(0,12);};
const exists=(exec:Exec,image:string)=>{try{exec('docker',['image','inspect','--format','{{.Id}}',image]);return true;}catch{return false;}};

/** The repository digest Docker recorded for a local image, as the runtime requires (name@sha256:...). */
export function digestReference(exec:Exec,image:string):string {
  const name=image.slice(0,image.lastIndexOf(':'));
  const digests=JSON.parse(exec('docker',['image','inspect','--format','{{json .RepoDigests}}',image]).trim()||'[]') as string[]|null;
  const reference=(digests??[]).find(d=>d.startsWith(name+'@sha256:'));
  if(!reference)throw new SetupError(`Docker recorded no digest for ${image}. Turn on the containerd image store `+
    '(Docker Desktop: Settings > General; Colima uses it by default), or push the image to a registry and set "image" in your config.');
  return reference;
}

/** Builds images/Dockerfile's target for the editor (first run only) and returns its digest reference. */
export function rendererImage(exec:Exec,example:string,editor:Editor,log:(line:string)=>void):string {
  const dockerfile=join(example,'images','Dockerfile');
  const image=`video-editing-${editor}:${hash(editor,readFileSync(dockerfile))}`;
  if(!exists(exec,image)){
    log(`Building the ${editor} renderer image ${image} (first run only; several minutes)...`);
    try{exec('docker',['build','--target',editor,'--tag',image,'--file',dockerfile,join(example,'images')],{inherit:true});}
    catch{throw new SetupError(`Building the ${editor} renderer image failed; see the Docker output above.`);}
  }
  return digestReference(exec,image);
}

// The coordinator image contains the packed runtime and this example's code, not the sample or your project.
const SHIPPED=new Set(['package.json','package-lock.json','tsconfig.json','src','scripts']);
const files=(root:string,directory=root):string[]=>readdirSync(directory).sort().flatMap(name=>{
  const path=join(directory,name);
  if(directory===root&&!SHIPPED.has(name))return [];
  return statSync(path).isDirectory()?files(root,path):[relative(root,path)];
});

/** Builds the trusted Linux coordinator (OpenTofu, Docker CLI, runtime, this example) once per content hash. */
export function coordinatorImage(exec:Exec,example:string,log:(line:string)=>void):string {
  const runtime=dirname(dirname(fileURLToPath(import.meta.resolve(RUNTIME))));
  const context=mkdtempSync(join(tmpdir(),'video-coordinator-'));
  try{
    const packed=JSON.parse(exec('npm',['pack','--ignore-scripts','--json','--pack-destination',context],{cwd:runtime})) as {filename:string}[];
    renameSync(join(context,packed[0].filename),join(context,'runtime.tgz'));
    const dockerfile=readFileSync(join(example,'coordinator','Dockerfile'));
    const image='video-editing-coordinator:'+hash(dockerfile,readFileSync(join(context,'runtime.tgz')),
      ...files(example).flatMap(name=>[name,readFileSync(join(example,name))]));
    if(exists(exec,image))return image;
    log(`Building the coordinator image ${image} (first run only)...`);
    cpSync(example,join(context,'example'),{recursive:true,filter:path=>{
      const parts=relative(example,path).split(sep);
      return parts[0]===''||(SHIPPED.has(parts[0])&&!parts.includes('node_modules'));
    }});
    bindRuntime(join(context,'example'),'file:/opt/runtime.tgz');
    cpSync(join(example,'coordinator','Dockerfile'),join(context,'Dockerfile'));
    try{exec('docker',['build','--tag',image,context],{inherit:true});}
    catch{throw new SetupError('Building the coordinator image failed; see the Docker output above.');}
    return image;
  }finally{rmSync(context,{recursive:true,force:true});}
}
