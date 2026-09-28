import { testTartOptions } from '../test/fixtures/provider-options.js';
/** Explicit real-VM proof. Arguments select a pinned image and a NEW owned evidence directory. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareTartDeployment, startTartVM, executeTartGuest, inspectTartDeployment } from '../src/index.js';
import type { DeploymentManifest } from '../src/index.js';

const [image, rootArg] = process.argv.slice(2);
if (!image || !rootArg) throw new Error('Usage: tsx scripts/verify-tart.ts pinned-image new-evidence-directory');
const root = resolve(rootArg);mkdirSync(root, { mode: 0o700 });
const manifests: DeploymentManifest[] = [];
const results: unknown[] = [];
const binary = (name: string) => execFileSync('which',[name],{encoding:'utf8'}).trim();
const runtime = await import(new URL('../dist/index.js',import.meta.url).href);
try {
  for (let n=0;n<2;n++) {
    const m=prepareTartDeployment(root,{schemaVersion:1,id:'vm-verification',revision:'1',harness:{name:'scripted-probe',version:'1'},
      deployment:{provider: 'tart', options: testTartOptions(),image,cpu:2,memoryMiB:2048},secrets:[],capture:{paths:[]}},
      {node:process.execPath,tart:binary('tart'),tofu:binary('tofu')});
    manifests.push(m);const path=join(m.directory,'manifest.json');
    await runtime.deployTart(path,{subject:'verification-owner',authorize:async()=>({status:'verified',evidenceId:'explicit-verification'}),inspectSecret:async()=>{throw Error('No secrets requested');}});
    await startTartVM(path);
    process.stdout.write(`Started VM ${n+1}\n`);
  }
  for (const m of manifests) {
    const path=join(m.directory,'manifest.json');let connected=false;
    for(let attempt=0;attempt<15;attempt++) {
      try { if((await executeTartGuest(path,['uname','-m'])).trim()==='aarch64') {connected=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(!connected) throw Error('Guest readiness not verified');
    const marker=randomUUID();
    await executeTartGuest(path,['sh','-c','cat > /tmp/runtime-proof'],marker);
    const read=(await executeTartGuest(path,['cat','/tmp/runtime-proof'])).trim();
    if(read!==marker) throw Error('Guest input/output mismatch');
    const mounts=(await executeTartGuest(path,['sh','-c','findmnt -n -t virtiofs || true'])).trim();
    if(mounts) throw Error('Unexpected host filesystem share');
    const machine=(await executeTartGuest(path,['cat','/etc/machine-id'])).trim();
    results.push({operationId:m.operationId,marker,machine,architecture:'aarch64',hostShares:false});
  }
  if((results[0] as {machine:string}).machine===(results[1] as {machine:string}).machine) throw Error('Guests reused machine identity');
  for(let n=0;n<manifests.length;n++) {
    const path=join(manifests[n]!.directory,'manifest.json');
    const actual=(await executeTartGuest(path,['cat','/tmp/runtime-proof'])).trim();
    if(actual!==(results[n] as {marker:string}).marker) throw Error('Guest filesystem isolation failed');
  }
  writeFileSync(join(root,'guest-evidence.json'),JSON.stringify(results,null,2));
  process.stdout.write('Two independent guests verified\n');
} catch {
  process.exitCode=1;process.stdout.write('VM verification incomplete; inspect retained operation records\n');
} finally {
  const cleanup=[];
  for(const m of manifests) {
    const path=join(m.directory,'manifest.json');
    try {
      const removed=await runtime.destroyTart(path);const observed=await inspectTartDeployment(path);
      cleanup.push({operationId:m.operationId,removed:!removed.present,absent:!observed.present});
    } catch {cleanup.push({operationId:m.operationId,outcome:'unknown'});process.exitCode=1;}
  }
  writeFileSync(join(root,'cleanup.json'),JSON.stringify(cleanup,null,2));
  process.stdout.write(JSON.stringify({cleanup,evidenceDirectory:root})+'\n');
}
