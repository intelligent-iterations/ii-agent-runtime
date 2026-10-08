// Executed by the stock image's read-only Node binary. Input is supplied over stdin,
// never shell interpolation or command-line arguments. No workload grant exists yet.
export const SETUP_EXECUTE = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input+=x);
process.stdin.on('end', () => {
  const {commands, proxy} = JSON.parse(input);
  fs.mkdirSync('/sandbox/user', {recursive:true}); fs.mkdirSync('/sandbox/tmp', {recursive:true});
  const fd=fs.openSync('/sandbox/user/agent-runtime-setup.log', fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW, 0o600);
  let count=0, exceeded=false;
  const child=cp.spawn('/bin/sh', ['-ec', commands.join('\n')], {cwd:'/sandbox/repository', env:{
    PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/sandbox/user', TMPDIR:'/sandbox/tmp', CI:'true',
    HTTP_PROXY:proxy, HTTPS_PROXY:proxy, http_proxy:proxy, https_proxy:proxy,
    npm_config_proxy:proxy, npm_config_https_proxy:proxy, NO_PROXY:'', no_proxy:''
  }, stdio:['ignore','pipe','pipe']});
  const log=data=>{count+=data.length; if(count>4194304){exceeded=true;child.kill('SIGKILL');return;} fs.writeSync(fd,data);};
  child.stdout.on('data',log);child.stderr.on('data',log);
  child.on('error',()=>process.exit(1));
  child.on('close',(code)=>{fs.closeSync(fd);process.stdout.write(JSON.stringify({exitCode:exceeded?-1:(code??-1),outputLimit:exceeded}));});
});`;

// Record the trusted idle processes before running repository-supplied commands.
// PID+starttime prevents a recycled PID from gaining the baseline exemption.
const PROCESS_SCAN = String.raw`
const fs=require('node:fs');
function scan(){return fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).flatMap(x=>{
 try {const stat=fs.readFileSync('/proc/'+x+'/stat','utf8');const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 const uid=fs.readFileSync('/proc/'+x+'/status','utf8').match(/^Uid:\s+(\d+)/m)?.[1];
 return uid==='10001'&&x!=='1'&&Number(x)!==process.pid&&rest[0]!=='Z'?[{pid:Number(x),start:rest[19]}]:[];
 }catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return [];throw e;}
});}`;
export const SETUP_BASELINE = PROCESS_SCAN + `process.stdout.write(JSON.stringify(scan()));`;
export const SETUP_KILL = PROCESS_SCAN + String.raw`
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',async()=>{const baseline=JSON.parse(input);
 const remaining=()=>scan().filter(p=>!baseline.some(b=>b.pid===p.pid&&b.start===p.start));
 for(let i=0;i<100;i++){const peers=remaining();if(!peers.length){process.stdout.write('sealed');return;}
 for(const p of peers){try{process.kill(p.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
 await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error('Setup processes survived');
});`;
