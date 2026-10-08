import assert from 'node:assert/strict';
import type { Worker } from '../../src/pipeline/ports.js';

/** Send real requests. The caller also checks its outside listener's request count. */
export async function proveNetwork(worker: Pick<Worker, 'run'>, gateway: string, outside: string) {
  const result = JSON.parse(await worker.run({ command: 'node', args: ['-e', `
    (async () => {
      let source=''; for await (const chunk of process.stdin) source+=chunk;
      const input=JSON.parse(source);
      const read = async url => fetch(url,{signal:AbortSignal.timeout(3000)}).then(async r=>({ok:r.ok,text:await r.text()}),()=>({ok:false}));
      console.log(JSON.stringify({gateway:await read(input.gateway),outside:await read(input.outside),internet:await read('https://example.com/')}));
    })();`], input: JSON.stringify({ gateway, outside }), timeoutMs: 15000, maxOutputBytes: 4096 }));
  assert.equal(result.gateway.text, 'data: first\n\ndata: last\n\n', 'gateway stream must arrive intact');
  assert.equal(result.outside.ok, false, 'outside route must be denied');
  assert.equal(result.internet.ok, false, 'internet route must be denied');
  return result;
}

/** Check the environment and readable configuration/writable trees, with a planted-file positive control. */
export async function proveCredentialSeparation(worker: Pick<Worker, 'run' | 'workspace'>, marker: string) {
  const scan = () => worker.run({ command: 'node', args: ['-e', `
    const fs=require('fs');
    (async()=>{
      let source='';for await(const chunk of process.stdin)source+=chunk;
      const input=JSON.parse(source);let found=JSON.stringify(process.env).includes(input.marker),files=0;
      function walk(path){let entries;try{entries=fs.readdirSync(path,{withFileTypes:true})}catch{return}
        for(const entry of entries){const file=path+'/'+entry.name;if(entry.isDirectory())walk(file);
          else if(entry.isFile()){try{if(fs.statSync(file).size<=1048576){files++;if(fs.readFileSync(file).includes(input.marker))found=true}}catch{}}}}
      for(const root of [input.workspace,'/tmp','/etc'])walk(root);
      console.log(JSON.stringify({found,files}));
    })();`], input: JSON.stringify({ workspace: worker.workspace, marker }), timeoutMs: 30000, maxOutputBytes: 4096 }).then(value => JSON.parse(value));
  const before = await scan();
  assert.equal(before.found, false, 'provider canary must not reach worker environment or files');
  await worker.run({ command: 'node', args: ['-e', `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const x=JSON.parse(s);require('fs').writeFileSync(x.path,x.marker)})`],
    input: JSON.stringify({ path: `${worker.workspace}/canary-probe`, marker }), timeoutMs: 10000, maxOutputBytes: 1024 });
  assert.equal((await scan()).found, true, 'the scanner must find a deliberately planted canary');
  await worker.run({ command: 'rm', args: ['--', `${worker.workspace}/canary-probe`], timeoutMs: 10000, maxOutputBytes: 1024 });
  assert.equal((await scan()).found, false);
  return { filesScanned: before.files, providerCanaryAbsent: true, plantedCanaryDetected: true };
}
