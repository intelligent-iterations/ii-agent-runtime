import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCodex, parseConfig } from '../src/config.js';

const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const filled = { ...example, project: 'ii-demo-shop', resource: 'checkout' };

test('config.example.json placeholders fail by field; the prefilled model and rates are valid', () => {
  assert.throws(() => parseConfig(example), /Set "project" in config\.json/);
  assert.throws(() => parseConfig({ ...example, project: 'ii-demo-shop' }), /Set "resource" in config\.json/);
  assert.throws(() => parseConfig({ ...filled, resourceType: 'gce_instance' }), /Set "resourceType"/);
  const config = parseConfig(filled);
  assert.doesNotThrow(() => checkCodex(config));
  assert.equal(config.model, 'gpt-5.6-terra');
  for (const key of ['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens']) {
    assert.throws(() => checkCodex(parseConfig({ ...filled, [key]: 0 })), new RegExp(`Set ${key}`));
    assert.throws(() => checkCodex(parseConfig({ ...filled, [key]: undefined })), new RegExp(`Set ${key}`));
  }
  assert.throws(() => checkCodex(parseConfig({ ...filled, model: 'YOUR_CODEX_MODEL' })), /Set "model"/);
});

test('emulator mode ignores logView and says so; live mode keeps it', () => {
  const logView = 'locations/global/buckets/_Default/views/checkout-errors';
  const emulated = parseConfig({ ...filled, logView, emulatorEndpoint: 'http://127.0.0.1:4588/' });
  assert.equal(emulated.emulator, 'http://127.0.0.1:4588'); assert.equal(emulated.logView, undefined);
  assert.deepEqual(emulated.notices, ['EMULATOR MODE: floci-gcp has no log views; logView is ignored.']);
  assert.equal(parseConfig({ ...filled, logView }).logView, logView);
  assert.throws(() => parseConfig({ ...filled, emulatorEndpoint: 'file:///etc/passwd' }), /http\(s\) URL/);
});

/** Runs the real CLI read path, as `npm start -- --read` does. */
function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args], { encoding: 'utf8', timeout: 60000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
}

test('the CLI tells a grant denial from an upstream failure, and prints the upstream reason only on the host', async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    bodies.push(JSON.parse(data));
    res.statusCode = 403; res.end('{"error":{"code":403,"message":"Permission denied"}}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = mkdtempSync(join(tmpdir(), 'cloud-logging-cli-test-'));
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ ...filled, resourceType: 'cloud_run_revision', logView: 'locations/global/buckets/_Default/views/v',
    emulatorEndpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  try {
    const denied = await cli(['--read', '--config', config, '--resource', 'payments']);
    assert.equal(denied.code, 1); assert.equal(bodies.length, 0);
    assert.match(denied.stderr, /^Request denied by the gateway grant \(HTTP 403\): only projects\/ii-demo-shop, service_name="checkout" is allowed\n$/);
    const failed = await cli(['--read', '--config', config]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, 'Cloud Logging request failed (HTTP 403)\nGateway HTTP 502: the upstream request failed; see the reason above\n');
    assert.match(failed.stdout, /EMULATOR MODE: floci-gcp has no log views; logView is ignored\./);
    assert.deepEqual(bodies.map(body => body.resourceNames), [['projects/ii-demo-shop']]);
    const placeholder = await cli(['--read', '--config', fileURLToPath(new URL('../config.example.json', import.meta.url))]);
    assert.deepEqual([placeholder.code, placeholder.stdout, placeholder.stderr], [1, '', 'Set "project" in config.json to your Google Cloud project ID\n']);
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
});
