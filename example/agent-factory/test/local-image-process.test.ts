import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localImageDrivers } from '../src/local-image.js';

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'factory-image-process-')));
  const binary = join(directory, 'registry.mjs');
  writeFileSync(binary, `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
const config=JSON.parse(readFileSync(process.argv[3],'utf8'));
if(config.http.address!=='127.0.0.1') process.exit(2);
createServer((request,response)=>{response.end('{}')}).listen(Number(config.http.port),config.http.address);
`, { mode: 0o700 });
  const probe = createServer(); await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(accept => probe.close(() => accept()));
  return { directory, binary, port: address.port, close() { rmSync(directory, { recursive: true, force: true }); } };
}
async function reachable(port: number) {
  try { return (await fetch(`http://127.0.0.1:${port}/v2/`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(500) })).ok; }
  catch { return false; }
}

test('owned registry process stops and an occupied port is never adopted', async () => {
  const f = await fixture();
  let stop;
  try {
    stop = await localImageDrivers.startRegistry(f.binary, f.directory, f.port);
    assert.equal(await reachable(f.port), true);
    await assert.rejects(localImageDrivers.startRegistry(f.binary, f.directory, f.port), /EADDRINUSE/);
    assert.equal(await reachable(f.port), true);
    await stop(); assert.equal(await reachable(f.port), false);
  } finally { await stop?.(); f.close(); }
});

test('registry process is removed when its owning process is killed', async () => {
  const f = await fixture();
  const source = `import {localImageDrivers} from ${JSON.stringify(pathToFileURL(resolve('src/local-image.ts')).href)};
await localImageDrivers.startRegistry(${JSON.stringify(f.binary)},${JSON.stringify(f.directory)},${f.port});
console.log('ready');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(Error('Registry owner did not become ready')), 15_000);
      child.stdout.once('data', () => { clearTimeout(timer); accept(); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Registry owner exited early')); });
    });
    assert.equal(await reachable(f.port), true);
    const exited = new Promise<void>(accept => child.once('exit', () => accept()));
    child.kill('SIGKILL'); await exited;
    for (let i = 0; i < 30 && await reachable(f.port); i++) await new Promise(accept => setTimeout(accept, 100));
    assert.equal(await reachable(f.port), false);
  } finally { child.kill('SIGKILL'); f.close(); }
});
