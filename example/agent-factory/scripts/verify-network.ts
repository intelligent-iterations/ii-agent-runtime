import { factoryTartOptions } from '../src/defaults.js';
/** Dedicated credential-free guest connectivity diagnosis; never relaxes network isolation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareTartDeployment, deployTart, startTartVM, executeTartGuest, destroyTart, inspectTartDeployment } from '@intelligent-iterations/ii-agent-runtime';
const [image, directory] = process.argv.slice(2);
if (!image || !directory) throw Error('Usage: verify-network.ts pinned-image new-directory');
const root = resolve(directory); mkdirSync(root, { mode: 0o700 });
const binary = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();
const manifest = prepareTartDeployment(root, { schemaVersion: 1, id: 'network-proof', revision: '1', harness: { name: 'diagnostic', version: '1' },
  deployment: { provider: 'tart', options: factoryTartOptions(), image, cpu: 2, memoryMiB: 2048 }, secrets: [], capture: { paths: [] } },
  { node: process.execPath, tofu: binary('tofu'), tart: binary('tart') });
const path = join(manifest.directory, 'manifest.json');
const probe = `import json,subprocess,socket
r={}
for name,command in [('addresses',['ip','-j','address']),('routes',['ip','-j','route']),('resolver',['resolvectl','status'])]:
 p=subprocess.run(command,capture_output=True,text=True,timeout=5);r[name]=p.stdout
p=subprocess.run(['curl','--silent','--show-error','--max-time','10','--output','/dev/null','--write-out','%{http_code}','https://api.github.com'],capture_output=True,text=True,timeout=15)
r['github']={'exitCode':p.returncode,'httpCode':p.stdout,'diagnostic':p.stderr}
print(json.dumps(r))`;
try {
  await deployTart(path, { subject: 'network-proof', authorize: async () => ({ status: 'verified', evidenceId: 'dedicated-credential-free-diagnosis' }), inspectSecret: async () => { throw Error('No secrets'); } });
  await startTartVM(path);
  const deadline = Date.now() + 90_000;
  while (true) { try { await executeTartGuest(path, ['true']); break; } catch { if (Date.now() >= deadline) throw Error('Guest not ready'); await new Promise(r => setTimeout(r, 1000)); } }
  for (let i = 0; i < 3; i++) {
    const result = JSON.parse(await executeTartGuest(path, ['python3', '-c', probe]));
    writeFileSync(join(root, `probe-${i}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ probe: i, github: result.github }));
    if (i < 2) await new Promise(r => setTimeout(r, 10_000));
  }
} finally {
  await destroyTart(path);
  assert.equal((await inspectTartDeployment(path)).present, false);
  writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ independentlyAbsent: true, manifestPath: path }));
  console.log('Diagnostic VM independently absent');
}
