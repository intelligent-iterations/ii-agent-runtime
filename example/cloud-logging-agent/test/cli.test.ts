import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/app.js';
import { checkCodex, parseConfig } from '../src/config.js';
import { interceptGoogle, testCredential } from './intercept-google.js';

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

test('the CLI always reads Cloud Logging: there is no emulator setting, and logView is kept', () => {
  const logView = 'locations/global/buckets/_Default/views/checkout-errors';
  assert.equal(parseConfig({ ...filled, logView }).logView, logView);
  assert.throws(() => parseConfig({ ...filled, emulatorEndpoint: 'http://127.0.0.1:4588' }), /Remove "emulatorEndpoint" from config\.json/);
});

/** A stand-in for logging.googleapis.com, reached only through interceptGoogle. */
async function fakeGoogle(handle: (body: any, res: ServerResponse) => void) {
  const bodies: any[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    bodies.push(JSON.parse(data)); handle(bodies.at(-1), res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

function configFile(settings: object) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-logging-cli-test-'));
  writeFileSync(join(directory, 'config.json'), JSON.stringify(settings));
  return { path: join(directory, 'config.json'), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

test('the read path tells a grant denial from an upstream failure, and prints the upstream reason only on the host', async () => {
  const google = await fakeGoogle((_body, res) => { res.statusCode = 403; res.end('{"error":{"code":403,"message":"Permission denied"}}'); });
  const config = configFile({ ...filled, resourceType: 'cloud_run_revision', logView: 'locations/global/buckets/_Default/views/v' });
  const out: string[] = [], err: string[] = [];
  const deps = { fetch: interceptGoogle(google.origin), resolveCredential: testCredential, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  try {
    await assert.rejects(main(['--read', '--config', config.path, '--resource', 'payments'], deps),
      /^Error: Request denied by the gateway grant \(HTTP 403\): only projects\/ii-demo-shop, service_name="checkout" is allowed$/);
    assert.equal(google.bodies.length, 0);
    await assert.rejects(main(['--read', '--config', config.path], deps), /Gateway HTTP 502: the upstream request failed; see the reason above/);
    assert.deepEqual(err, ['Cloud Logging request failed (HTTP 403)']);
    assert.deepEqual(google.bodies.map(body => body.resourceNames), [['projects/ii-demo-shop/locations/global/buckets/_Default/views/v']]);
  } finally { google.close(); config.remove(); }
});

test('a placeholder config fails with one plain line from the real CLI process', async () => {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--read', '--config',
      fileURLToPath(new URL('../config.example.json', import.meta.url))], { encoding: 'utf8', timeout: 60000 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
  assert.deepEqual([result.code, result.stdout, result.stderr], [1, '', 'Set "project" in config.json to your Google Cloud project ID\n']);
});

test('the demo reads the granted service, denies the rest before Google is called, and uses the credential once', async () => {
  const now = Date.now();
  const entry = (insertId: string, minutesAgo: number) => ({ insertId, severity: 'ERROR', textPayload: 'Stripe API timeout after 10000 ms',
    timestamp: new Date(now - minutesAgo * 60000).toISOString(), logName: 'projects/ii-demo-shop/logs/run.googleapis.com%2Fstderr',
    resource: { type: 'cloud_run_revision', labels: { service_name: 'checkout' } } });
  const google = await fakeGoogle((_body, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ entries: [entry('a', 3), entry('b', 9)] })); });
  const config = configFile({ ...filled, resourceType: 'cloud_run_revision' });
  let credentials = 0;
  const out: string[] = [], err: string[] = [];
  try {
    const code = await main(['--demo', '--config', config.path, '--minutes', '60'], { fetch: interceptGoogle(google.origin), out: l => out.push(l), err: l => err.push(l),
      resolveCredential: () => { credentials++; return testCredential(); } });
    const text = out.join('\n');
    assert.equal(code, 0, text + err.join('\n'));
    assert.match(text, /2 ERROR-or-higher entries in 1 group\./);
    assert.match(text, /2\. Read another service, "payments":\n {3}Denied by the gateway grant \(HTTP 403\)\./);
    assert.match(text, /3\. Delete a log:\n {3}Denied \(HTTP 403\): the gateway exposes no write operation\./);
    assert.match(text, /Google received 1 request, all for the granted read/);
    assert.equal(google.bodies.length, 1); assert.equal(credentials, 1); assert.deepEqual(err, []);
  } finally { google.close(); config.remove(); }
});

test('when Google refuses the read, the demo still shows both denials and exits 1', async () => {
  const google = await fakeGoogle((_body, res) => { res.statusCode = 403; res.end('{}'); });
  const config = configFile({ ...filled, resourceType: 'cloud_run_revision' });
  const out: string[] = [], err: string[] = [];
  try {
    const code = await main(['--demo', '--config', config.path], { fetch: interceptGoogle(google.origin), resolveCredential: testCredential,
      out: l => out.push(l), err: l => err.push(l) });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /Failed: gateway HTTP 502; the reason is printed above\.[^]*Denied by the gateway grant[^]*no write operation/);
    assert.deepEqual(err, ['Cloud Logging request failed (HTTP 403)']);
  } finally { google.close(); config.remove(); }
});
