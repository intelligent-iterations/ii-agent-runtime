import { proveRetainedRecovery } from './recovery-proof.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerTofuTarget, executionServices, openWorkerStdioEndpoint, openTrustedProcess, runTrustedProcess } from './dist/pipeline/index.js';

const image = process.argv[2];
assert.match(image, /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
const root = mkdtempSync(join(realpathSync('/root'), 'runtime-proof-'));
const owner = randomUUID(); writeFileSync(join(root, '.owner'), owner, { mode: 0o600 });
const home = join(root, 'controller'); mkdirSync(home, { mode: 0o700 });
const marker = join(home, 'private-canary'); writeFileSync(marker, 'synthetic-private-value', { mode: 0o600 });
const diagnosticProcess = async request => {
  const path = join(request.cwd, 'proof-process-stderr');
  try {
    return await runTrustedProcess({ ...request, command: '/bin/bash', args: ['-c',
      '"$@" 2> >(head -c 8192 > "$PROBE_STDERR"); result=$?; wait; exit "$result"', 'diagnostic', request.command, ...request.args],
      env: { ...request.env, PROBE_STDERR: path } });
  } catch (error) {
    let detail = ''; try { detail = readFileSync(path, 'utf8').slice(-8000); } catch { /* no child output */ }
    throw Error(error.message + ': ' + detail);
  }
};
const target = dockerTofuTarget({ parent: root, executablePath: '/usr/local/bin:/usr/bin:/bin',
  namespacePolicyImage: image, workspaceHelperImage: image, services: { ...executionServices, openTofuWorker: options => executionServices.openTofuWorker({ ...options, process: diagnosticProcess }) } });
const deadline = Date.now() + 360000;
const resources = { image, cpu: 1, memoryMiB: 512, timeoutSeconds: 360,
  configurationDigest: 'sha256:' + 'a'.repeat(64), userNamespaces: true, diskGiB: 1 };
let endpoint, isolation, server;
let calls = 0, proof, diskEvidence, failed, cleanupConfirmed = false, phase = 'provision';
const fixtureErrors = [];
try {
  const worker = await target.provision(resources, { deadlineMs: deadline, signal: new AbortController().signal });
  phase = 'volume-reference';
  const targetDirectories = readdirSync(root).filter(name => /^agent-runtime-[a-f0-9]{32}$/.test(name));
  assert.equal(targetDirectories.length, 1);
  const targetDirectory = join(root, targetDirectories[0]);
  const workerDirectories = readdirSync(targetDirectory).filter(name => /^worker-[a-f0-9]{32}$/.test(name));
  assert.equal(workerDirectories.length, 1);
  const storageOwner = readFileSync(join(targetDirectory, workerDirectories[0], '.owner'), 'utf8');
  await assert.rejects(diagnosticProcess({ command: 'docker', args: ['volume', 'rm', 'agent-runtime-disk-' + storageOwner],
    cwd: root, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 10000, maxOutputBytes: 65536 }), /volume is in use/);
  phase = 'preparation';
  const command = (command, args) => worker.run({ command, args, timeoutMs: 10000, maxOutputBytes: 65536 });
  await command('mkdir', ['-p', '/workspace/repository/.git', '/workspace/user', '/workspace/tmp']);
  await command('/usr/bin/python3', ['-c', 'from pathlib import Path; Path("/workspace/repository/positive").write_text("worker-readable"); Path("/workspace/repository/.git/protected").write_text("git-state")']);
  phase = 'disk-bound';
  diskEvidence = JSON.parse(await command('/usr/bin/python3', ['-c', `import errno,json,os
path='/workspace/bound-test'; fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
try:
 stats=os.statvfs('/workspace'); size=stats.f_blocks*stats.f_frsize
 assert 800000000<size<=1073741824
 try:
  os.posix_fallocate(fd,0,2*1073741824)
  raise AssertionError('workspace limit not enforced')
 except OSError as error:
  assert error.errno==errno.ENOSPC
 print(json.dumps({'filesystemBytes':size,'overflowDenied':True}))
finally:
 os.close(fd); os.unlink(path)
`]));
  assert.equal(diskEvidence.overflowDenied, true);
  diskEvidence.backingVolumeProtected = true;
  phase = 'isolation';
  isolation = await worker.isolate();
  phase = 'executor-transport';
  endpoint = await openWorkerStdioEndpoint(worker, { command: '/usr/bin/env', args: ['-i',
    'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/workspace/user', 'CODEX_HOME=/workspace/user', 'TMPDIR=/workspace/tmp',
    'codex', 'exec-server', '--listen', 'stdio'], timeoutMs: deadline - Date.now(), maxInputBytes: 16777216, maxOutputBytes: 16777216 }, { parent: root });
  writeFileSync(join(home, 'environments.toml'), ['default = "worker"', 'include_local = false', '[[environments]]', 'id = "worker"',
    'program = ' + JSON.stringify(endpoint.command), 'args = ' + JSON.stringify(endpoint.args), 'cwd = ' + JSON.stringify(home), ''].join('\n'));
  const source = ['import json,os,pathlib',
    `result={"uid":os.getuid(),"privateReadable":os.access(${JSON.stringify(marker)},os.R_OK)}`,
    'result["positiveRead"]=pathlib.Path("/workspace/repository/positive").read_text()=="worker-readable"',
    'try:', ' pathlib.Path("/workspace/repository/.git/protected").write_text("unauthorized")',
    ' result["gitWriteDenied"]=False', 'except PermissionError: result["gitWriteDenied"]=True',
    'pathlib.Path("/workspace/repository/proof.json").write_text(json.dumps(result))', 'print(json.dumps(result))'].join('\n');
  server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1048576) throw Error('fixture-input-limit'); }
      const parsed = JSON.parse(body); calls++;
      assert.ok(calls <= 2);
      const id = 'fixture-' + calls;
      const events = [{ type: 'response.created', response: { id } }];
      if (calls === 1) {
        assert.ok(parsed.tools.flatMap(tool => tool.type === 'namespace' ? tool.tools : [tool]).some(tool => tool.name === 'exec_command'));
        events.push({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fixture-call', name: 'exec_command',
          arguments: JSON.stringify({ cmd: "python3 -c '" + source.replaceAll("'", "'\\''") + "'", login: false, yield_time_ms: 10000 }) } });
      } else events.push({ type: 'response.output_item.done', item: { type: 'message', id: 'fixture-message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete' }] } });
      events.push({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      const output = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(output);
    } catch { fixtureErrors.push('fixture-protocol-failed'); response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(home, 'config.toml'), [
    'model_provider = "fixture"', 'model = "fixture-model"', 'approval_policy = "never"', 'default_permissions = "ii-workshop"', 'web_search = "disabled"',
    '[features]', 'hooks = false', 'shell_snapshot = false', '[model_providers.fixture]', 'name = "Synthetic fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    '[permissions.ii-workshop.filesystem]', '":minimal" = "read"', '"/workspace/repository/.git" = "deny"',
    '[permissions.ii-workshop.filesystem.":workspace_roots"]', '"." = "write"', '[permissions.ii-workshop.network]', 'enabled = false', '',
  ].join('\n'));
  // Codex canonicalizes --cd locally before selecting the external executor.
  // This empty placeholder belongs to the disposable controller, not the worker.
  mkdirSync('/workspace', { mode: 0o700 });
  mkdirSync('/workspace/repository', { mode: 0o700 });
  phase = 'codex';
  const controller = await openTrustedProcess({ command: '/bin/sh', args: ['-c', 'exec "$@" 2>&1', 'fixture-codex', 'codex', '--no-daemon', '-a', 'never', 'exec', '--json', '--strict-config', '--ephemeral',
    '--skip-git-repo-check', '--ignore-rules', '--cd', '/workspace/repository', 'Run the synthetic executor fixture.'], cwd: home,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home }, timeoutMs: 120000, maxInputBytes: 1024, maxOutputBytes: 1048576 });
  controller.end();
  let diagnostic = "";
  try {
    for await (const chunk of controller.output) diagnostic += chunk;
    const result = await controller.completion;
    assert.equal(result.exitCode, 0, diagnostic.slice(-8000));
  } finally { await controller.close(); }
  phase = 'assertions';
  assert.equal(calls, 2); assert.deepEqual(fixtureErrors, []);
  proof = JSON.parse(await command('cat', ['/workspace/repository/proof.json']));
  assert.deepEqual(proof, { uid: 10001, privateReadable: false, positiveRead: true, gitWriteDenied: true });
  assert.equal(await command('cat', ['/workspace/repository/.git/protected']), 'git-state');
} catch (error) { failed = { phase, name: error.name, message: error.message }; }
finally {
  await endpoint?.close().catch(() => { failed ??= { message: 'endpoint-cleanup-failed' }; });
  if (server) await new Promise(resolve => server.close(resolve));
  await isolation?.close().catch(() => { failed ??= { message: 'network-cleanup-failed' }; });
  try { await target.close(); cleanupConfirmed = true; } catch (error) { failed = { message: error.message }; }
  assert.equal(readFileSync(join(root, '.owner'), 'utf8'), owner);
  if (cleanupConfirmed) rmSync(root, { recursive: true });
}
let recoveryProof;
if (!failed && cleanupConfirmed) {
  try { recoveryProof = await proveRetainedRecovery(image); }
  catch (error) { failed = { phase: 'retained-recovery', name: error.name, message: error.message }; cleanupConfirmed = false; }
}
console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', proof, diskEvidence, recoveryProof, failure: failed, cleanupConfirmed,
  syntheticResponses: calls, realModelRequests: 0, realCredentials: false }));
process.exitCode = failed ? 1 : 0;
