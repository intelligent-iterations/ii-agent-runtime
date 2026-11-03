import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerTofuTarget, executionServices, runTrustedProcess } from './dist/pipeline/index.js';

/** A second process imports the installed public cleanup API; no original closure is reused. */
export async function proveRetainedRecovery(image) {
  const root = mkdtempSync(join(realpathSync('/root'), 'recovery-proof-')), owner = randomUUID();
  writeFileSync(join(root, '.owner'), owner, { mode: 0o600 });
  let latest, confirmed = false;
  try {
    const target = dockerTofuTarget({ parent: root, executablePath: '/usr/local/bin:/usr/bin:/bin',
      namespacePolicyImage: image, workspaceHelperImage: image, services: executionServices,
      checkpoint: async value => { latest = value; writeFileSync(join(root, 'checkpoint-' + value.phase + '.json'), JSON.stringify(value), { mode: 0o600, flag: 'wx' }); } });
    const resources = { image, cpu: 1, memoryMiB: 512, timeoutSeconds: 120, diskGiB: 1, userNamespaces: true, configurationDigest: 'sha256:' + 'b'.repeat(64) };
    const worker = await target.provision(resources);
    await worker.isolate();
    assert.equal(latest.phase, 'provisioning');
    const request = { parent: root, state: latest, expected: { configurationDigest: resources.configurationDigest,
      namespacePolicyImage: image, workspaceHelperImage: image }, executablePath: '/usr/local/bin:/usr/bin:/bin' };
    const file = join(root, 'cleanup-request.json'); writeFileSync(file, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    const program = `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {recoverDockerTarget,runTrustedProcess} from './dist/pipeline/index.js';
const request=JSON.parse(readFileSync(process.argv[1],'utf8'));
const diagnostic=async command=>{
 const file=join(command.cwd,'recovery-process-stderr');
 try{return await runTrustedProcess({...command,command:'/bin/bash',args:['-c','"$@" 2> >(head -c 8192 > "$PROBE_STDERR"); result=$?; wait; exit "$result"','diagnostic',command.command,...command.args],env:{...command.env,PROBE_STDERR:file}});}
 catch(error){let detail='';try{detail=readFileSync(file,'utf8').slice(-8000);}catch{}throw Error(error.message+': '+detail);}
};
try { await recoverDockerTarget({...request,process:diagnostic,checkpoint:async state=>writeFileSync(join(request.parent,'cleanup-receipt.json'),JSON.stringify(state),{mode:0o600})}); }
catch(error){writeFileSync(join(request.parent,'cleanup-error.json'),JSON.stringify({name:error.name,message:error.message}),{mode:0o600});process.exitCode=1;}
console.log(JSON.stringify({freshProcess:true,cleanupConfirmed:true,workloadRestarted:false}));`;
    let output;
    try { output = await runTrustedProcess({ command: process.execPath, args: ['--input-type=module', '-e', program, file],
      cwd: '/app', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 360000, maxOutputBytes: 1048576 }); }
    catch {
      let failure = 'provider cleanup failed';
      try { failure = JSON.parse(readFileSync(join(root, 'cleanup-error.json'), 'utf8')).message; } catch { /* preserve opaque process failure */ }
      throw Error('Retained cleanup failed at ' + root + ': ' + failure);
    }
    const receipt = JSON.parse(readFileSync(join(root, 'cleanup-receipt.json'), 'utf8'));
    assert.equal(receipt.phase, 'cleaned'); assert.deepEqual(receipt.reference, latest.reference);
    const result = JSON.parse(output.trim()); assert.equal(result.freshProcess, true); assert.equal(result.workloadRestarted, false);
    confirmed = true;
    return result;
  } finally {
    assert.equal(readFileSync(join(root, '.owner'), 'utf8'), owner);
    if (confirmed) rmSync(root, { recursive: true });
  }
}
