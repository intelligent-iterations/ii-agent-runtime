// Runs inside the coordinator container that npm run demo starts, or directly on a Linux
// host with OpenTofu, Python 3.11+ and the Docker CLI: node dist/src/cli.js --config config.json
import {readFileSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {configuration,ConfigurationError} from './config.js';
import {renderProject} from './run.js';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){
 console.log('npm run demo -- --config config.json\nRun a prepared HyperFrames, Remotion or MoviePy project in an explicit Docker runtime.\nEditor images, project files and commands are supplied by you; no model or account credential is sent to the worker.');
}else{
 try{
  const image=args.length===4&&args[2]==='--image'?args[3]:undefined;
  if(!(args.length===2||image)||args[0]!=='--config')throw new ConfigurationError(['Use npm run demo -- --config config.json; see --help.']);
  const path=resolve(args[1]);let value:unknown;
  try{value=JSON.parse(readFileSync(path,'utf8'));}catch{throw new ConfigurationError(['config: supply a readable JSON file; copy config.example.json first.']);}
  const c=configuration(value,dirname(path),{image});
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  let r;
  try{r=await renderProject(c,undefined,controller.signal);}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
  // Relative to the config's folder, so shared logs don't reveal your home path.
  console.log(JSON.stringify({runId:r.runId,editor:r.editor,status:r.status,cleanup:r.cleanup,output:relative(dirname(path),c.output)||'.',videos:r.media?.videos.length??0}));
  if(r.status!=='passed')process.exitCode=1;
 }catch(error){console.error(error instanceof ConfigurationError?error.message:'Unable to render the project. Check its files, editor image, Docker socket and OpenTofu installation.');process.exitCode=1;}
}
