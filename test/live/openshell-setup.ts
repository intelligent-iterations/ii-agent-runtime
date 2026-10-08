/** Real-backend assertions: a green step requires working setup and a verified seal. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openshellTarget } from '../../src/providers/execution/openshell/target.js';
import { workerResources } from '../../src/pipeline/worker-resources.js';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { fixture } from '../runtime-fixture.js';
const address = process.env.OPENSHELL_TEST_GATEWAY_ADDRESS!;
for (const scenario of ['install', 'failure', 'timeout', 'cancel', 'output-limit'] as const) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'openshell-setup-live-')));
  const target = openshellTarget({ parent, executablePath: process.env.PATH!, host: { gatewayAddress: address } });
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const config = fixture();
    const worker = await target.provision(workerResources(compileConfiguration({ ...config, environment: { ...config.environment, provider: 'openshell', cpu: 1, memoryMiB: 1024,
      image: 'node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c' } })));
    const source = join(parent, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'setup-proof', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } }));
    writeFileSync(join(source, 'verify-egress.cjs'), String.raw`
const assert=require('assert/strict'),http=require('http');
const proxy=new URL(process.env.HTTPS_PROXY);
const auth='Basic '+Buffer.from(proxy.username+':'+proxy.password).toString('base64');
(async()=>{for(const host of ['127.0.0.1','10.0.0.1','169.254.169.254']){
 const code=await new Promise((resolve,reject)=>{const req=http.request({host:proxy.hostname,port:proxy.port,path:'http://'+host+'/',headers:{'proxy-authorization':auth}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});
 assert.equal(code,403,'private destination must be denied');
}await assert.rejects(fetch('https://registry.npmjs.org/is-number',{signal:AbortSignal.timeout(3000)}));
console.log('private destinations and direct bypass denied');})();
`);
    await worker.load(source);
    const background = `node -e 'require("fs").writeFileSync("/sandbox/user/background.pid",String(process.pid));setInterval(()=>{},1000)' >/dev/null 2>&1 & until test -f /sandbox/user/background.pid; do sleep 0.1; done`;
    const commands = scenario === 'install' ? ['node verify-egress.cjs', 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund', 'npm ci --no-audit --no-fund', background] : scenario === 'failure' ? [background, 'exit 23'] : scenario === 'output-limit' ? [background, `node -e 'process.stdout.write("x".repeat(8388608))'`] : [background, 'sleep 120'];
    if (scenario === 'cancel') timer = setTimeout(() => controller.abort(), 20000);
    const setup = worker.setup(commands, { timeoutMs: scenario === 'timeout' ? 1000 : 60000, signal: controller.signal });
    if (scenario === 'cancel' || scenario === 'output-limit') {
      await assert.rejects(setup, scenario === 'cancel' ? /cancel/i : /output limit/i);
      await assert.rejects(worker.isolate(), /lifecycle state/);
    }
    else {
      const result = await setup;
      assert.equal(result.exitCode, scenario === 'install' ? 0 : scenario === 'failure' ? 23 : -1);
      assert.equal(result.timedOut, scenario === 'timeout');
      const probe = await worker.run({ command: 'node', args: ['-e', String.raw`
const fs=require('fs'); const p='/sandbox/user/background.pid';
if(fs.existsSync(p)){const pid=fs.readFileSync(p,'utf8');try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');if(!stat.includes(') Z '))throw Error('setup process survived')}catch(e){if(e.code!=='ENOENT')throw e;}}
fetch('https://registry.npmjs.org/is-number',{signal:AbortSignal.timeout(3000)}).then(()=>{throw Error('setup egress survived')},()=>console.log('sealed'));
`], timeoutMs: 5000, maxOutputBytes: 8192 });
      assert.equal(probe.trim(), 'sealed');
      if (scenario === 'install') assert.equal((await worker.run({ command: 'node', args: ['-e', `console.log(require('/sandbox/repository/node_modules/is-number')(42))`], timeoutMs: 10000, maxOutputBytes: 1000 })).trim(), 'true');
      await worker.isolate();
    }
    console.log(JSON.stringify({ scenario, result: 'passed' }));
  } finally {
    if (timer) clearTimeout(timer);
    await target.close();
    rmSync(parent, { recursive: true, force: true });
  }
  console.log(`${scenario}: sandbox deletion confirmed`);
}
