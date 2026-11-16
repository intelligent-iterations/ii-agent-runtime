import {constants} from 'node:fs';
import {lstat,mkdir,open,opendir,realpath} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigurationError,type Configuration} from './config.js';

// Count every encountered entry, including excluded files and empty directories.
const MAX_ENTRIES=4096,MAX_DEPTH=32,CHUNK_BYTES=65536;
export async function stageInput(c:Configuration,destination:string,context:{deadlineMs:number;signal:AbortSignal}={deadlineMs:Date.now()+30000,signal:new AbortController().signal}):Promise<Record<string,{bytes:number;sha256:string}>> {
  const files:Record<string,{bytes:number;sha256:string}>=Object.create(null);
  const seen=new Set<string>();let total=0,entries=0;
  const active=()=>{context.signal.throwIfAborted();if(Date.now()>=context.deadlineMs)throw new ConfigurationError(['inputs: staging deadline reached.']);};
  active();
  let root:string;
  try{root=await realpath(c.project);}catch{throw new ConfigurationError(['project: choose an existing, readable directory.']);}
  const visit=async(source:string,depth:number):Promise<void>=>{
    active();
    if(++entries>MAX_ENTRIES||depth>MAX_DEPTH)throw new ConfigurationError(['inputs: project exceeds 4096 visited entries or 32 directory levels.']);
    const name=relative(root,source);
    if(seen.has(name))return;seen.add(name);
    if(name.split('/').some(p=>p.startsWith('.'))||/(?:\.pem|\.key|\.p12|credentials\.json|id_rsa|id_ed25519)$/i.test(name))return;
    const st=await lstat(source);
    if(st.isSymbolicLink())throw new ConfigurationError([`inputs: symbolic links are not accepted: ${name}`]);
    if(await realpath(source)!==source)throw new ConfigurationError([`inputs: path traverses a symbolic link: ${name}`]);
    if(st.isDirectory()){
      // opendir streams entries; readdir would allocate an unbounded directory listing.
      const directory=await opendir(source);
      for await(const entry of directory)await visit(join(source,entry.name),depth+1);
      return;
    }
    if(!st.isFile()||st.nlink!==1)throw new ConfigurationError([`inputs: expected an ordinary single-link file: ${name}`]);
    if(total+st.size>c.maxInputMiB*1048576||Object.keys(files).length>=2048)throw new ConfigurationError(['inputs: project exceeds maxInputMiB or 2048 files; select fewer inputs.']);
    const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const before=await input.stat();
      const changed=()=>new ConfigurationError([`inputs: file changed while staging: ${name}`]);
      if(!before.isFile()||before.nlink!==1||before.ino!==st.ino||before.dev!==st.dev||before.size!==st.size)throw changed();
      const target=join(destination,name);await mkdir(resolve(target,'..'),{recursive:true,mode:0o700});
      const output=await open(target,'wx',0o600);const hash=createHash('sha256');let bytes=0;
      try{
        const buffer=Buffer.alloc(CHUNK_BYTES);
        while(true){
          active();const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,before.size-bytes+1),null);
          if(!bytesRead)break;
          bytes+=bytesRead;
          if(bytes>before.size||total+bytes>c.maxInputMiB*1048576)throw changed();
          const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);await output.writeFile(chunk);
        }
        const after=await input.stat();
        if(bytes!==before.size||after.size!==bytes||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1)throw changed();
        total+=bytes;files[name]={bytes,sha256:hash.digest('hex')};
      }finally{await output.close();}
    }finally{await input.close();}
  };
  for(const name of c.inputs){
    try{await visit(join(root,name),0);}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ConfigurationError([`inputs: missing ${name}; correct project or inputs.`]);
      throw error;
    }
  }
  active();
  if(!Object.keys(files).length)throw new ConfigurationError(['inputs: no shareable files were selected.']);
  return files;
}
