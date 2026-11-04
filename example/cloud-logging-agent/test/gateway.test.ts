import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gcpCredentials, hostLine, startGateway } from '../src/gateway.js';
import { cloudLoggingOperation, cloudLoggingTool, filterFor, MAX_WINDOW_MS, messageOf, summarize, type Scope } from '../src/cloud-logging.js';
import { interceptGoogle } from './intercept-google.js';

// Fixtures follow the documented entries.list response shape (LogEntry, nextPageToken). They are not live captures.
const scope: Scope = { project: 'ii-demo-checkout', resourceType: 'cloud_function', resource: 'checkout' };
const resource = (name: string) => ({ type: 'cloud_function', labels: { function_name: name, region: 'us-central1', project_id: 'ii-demo-checkout' } });

test('real runtime gateway enforces project, resource, operation, input and credential isolation before Google', async () => {
  const calls: Array<{ path: string; auth: string; body: any }> = [];
  const now = Date.now(), secret = 'ya29.unit-token-that-must-not-reach-the-agent';
  let resolution = 0;
  const hostLines: string[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    calls.push({ path: String(req.url), auth: String(req.headers.authorization), body: JSON.parse(data) });
    res.setHeader('content-type', 'application/json');
    if (calls.length === 1) { res.end(JSON.stringify({ entries: [], nextPageToken: 'page-two' })); return; }
    const at = (ms: number) => new Date(now - ms).toISOString();
    res.end(JSON.stringify({ entries: [
      { insertId: 'e-1', timestamp: at(1000), severity: 'ERROR', resource: resource('checkout'), textPayload: 'Error: checkout timeout',
        logName: 'projects/ii-demo-checkout/logs/cloudfunctions.googleapis.com%2Fcloud-functions' },
      { insertId: 'e-1', timestamp: at(1000), severity: 'ERROR', resource: resource('checkout'), textPayload: 'Error: checkout timeout' },
      { insertId: 'e-2', timestamp: at(2000), severity: 'INFO', resource: resource('checkout'), textPayload: 'started' },
      { insertId: 'e-3', timestamp: at(2000), severity: 'ERROR', resource: resource('payments'), textPayload: 'other function' },
      { insertId: 'e-4', timestamp: at(MAX_WINDOW_MS * 2), severity: 'ERROR', resource: resource('checkout'), textPayload: 'too old' },
    ] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const gateway = await startGateway({ ...scope, address: '127.0.0.1', fetch: interceptGoogle(`http://127.0.0.1:${address.port}`),
    deadlineMs: now + 60000, signal: new AbortController().signal,
    resolveCredential: async () => { resolution++; return { values: { accessToken: secret }, expiresAt: now + 60000 }; },
    model: { respond: async () => new Response(null, { status: 403 }) }, hostLog: line => hostLines.push(line) });
  const query = { project: scope.project, resource: scope.resource, startTime: now - 60000, endTime: now };
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  const call = (name: string, input: unknown) => fetch(`${gateway.endpoint}/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
  try {
    assert.equal((await call('cloudLoggingErrors', { ...query, project: 'ii-demo-payments' })).status, 403);
    assert.equal((await call('cloudLoggingErrors', { ...query, resource: 'payments' })).status, 403);
    assert.equal((await call('deleteLog', query)).status, 403);
    assert.equal((await call('cloudLoggingErrors', { ...query, filter: 'severity>=DEBUG' })).status, 400);
    assert.equal((await call('cloudLoggingErrors', { ...query, endpoint: 'https://evil.invalid' })).status, 400);
    assert.equal((await call('cloudLoggingErrors', { ...query, resource: 'checkout" OR resource.type="gce_instance' })).status, 400);
    assert.equal((await call('cloudLoggingErrors', { ...query, startTime: 'yesterday' })).status, 400);
    assert.equal((await fetch(`${gateway.endpoint}/tools`)).status, 403);
    assert.equal(calls.length, 0); assert.equal(resolution, 0);
    const discovery = await (await fetch(`${gateway.endpoint}/tools`, { headers })).text();
    assert.ok(!discovery.includes(secret)); assert.ok(!discovery.includes('deleteLog'));
    const response = await call('cloudLoggingErrors', query);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.matchedEntries, 1); assert.equal(result.errors[0].references[0].insertId, 'e-1');
    assert.equal(result.truncated, false); assert.equal(calls.length, 2); assert.equal(resolution, 1);
    assert.ok(calls.every(c => c.path === '/v2/entries:list' && c.auth === `Bearer ${secret}` &&
      JSON.stringify(c.body.resourceNames) === '["projects/ii-demo-checkout"]' && c.body.filter === filterFor(scope, query.startTime, query.endTime)));
    assert.equal(calls[0]!.body.pageToken, undefined); assert.equal(calls[1]!.body.pageToken, 'page-two');
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(gateway.report.coverage, 'partial'); assert.equal(gateway.report.checks[0]!.status, 'unknown');
    assert.equal((await call('cloudLoggingErrors', { ...query, startTime: now - MAX_WINDOW_MS - 1 })).status, 502);
    assert.equal((await call('cloudLoggingErrors', { ...query, startTime: now + 120000, endTime: now + 180000 })).status, 502);
    assert.equal(calls.length, 2);
    assert.deepEqual(hostLines, Array(2).fill('Cloud Logging read not attempted: Invalid time window'));
  } finally { await gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('provider errors and repeated page tokens stay bounded', async () => {
  const context = { subject: 'cloud-logging-codex', executionId: 'x', attemptId: '1', inputDigest: 'x', deadlineMs: Date.now() + 60000, signal: new AbortController().signal };
  const credential = { values: { accessToken: 't' }, expiresAt: Date.now() + 60000 };
  const input = { project: scope.project, resource: scope.resource, startTime: Date.now() - 60000, endTime: Date.now() };
  let pages = 0;
  const looping = cloudLoggingOperation({ resourceType: 'cloud_function',
    fetch: async () => { pages++; return Response.json({ entries: [], nextPageToken: 'same' }); } });
  const result = await looping.execute(input, credential, context) as { truncated: boolean };
  assert.equal(result.truncated, true); assert.equal(pages, 2);
  let calls = 0;
  const flaky = cloudLoggingOperation({ resourceType: 'cloud_function', retryDelaysMs: [1, 1],
    fetch: async () => ++calls < 3 ? new Response('{}', { status: calls === 1 ? 500 : 503 }) : Response.json({ entries: [] }) });
  assert.equal((await flaky.execute(input, credential, context) as { matchedEntries: number }).matchedEntries, 0);
  assert.equal(calls, 3);
  calls = 0;
  const down = cloudLoggingOperation({ resourceType: 'cloud_function', retryDelaysMs: [1, 1],
    fetch: async () => { calls++; return new Response('{}', { status: 500 }); } });
  await assert.rejects(down.execute(input, credential, context), /HTTP 500/);
  assert.equal(calls, 3);
  const denied = cloudLoggingOperation({ resourceType: 'cloud_function',
    fetch: async () => new Response('{"error":{"code":403,"message":"Permission denied"}}', { status: 403 }) });
  await assert.rejects(denied.execute(input, credential, context), /HTTP 403/);
  const huge = cloudLoggingOperation({ resourceType: 'cloud_function',
    fetch: async () => new Response(new Uint8Array(9 * 1024 * 1024)) });
  await assert.rejects(huge.execute(input, credential, context), /too large/);
});

test('summary groups messages, cleans control characters and reads every payload shape', () => {
  const result = summarize([
    { insertId: 'b', timestamp: new Date(2000).toISOString(), severity: 'ERROR', textPayload: '\u001b[31mError: order 456 timed out' },
    { insertId: 'a', timestamp: new Date(1000).toISOString(), severity: 'ERROR', textPayload: '\u001b[31mError: order 456 timed out' },
  ], scope, 0, 3000, true);
  assert.equal(result.errors.length, 1); assert.equal(result.errors[0]!.count, 2);
  assert.equal(result.errors[0]!.firstSeen, new Date(1000).toISOString());
  assert.equal(result.errors[0]!.lastSeen, new Date(2000).toISOString());
  assert.ok(!JSON.stringify(result).includes('\\u001b'));
  assert.ok(result.errors[0]!.references[0]!.url.includes('insertId%3D%22b%22'));
  assert.ok(result.errors[0]!.references[0]!.url.endsWith('?project=ii-demo-checkout'));
  assert.equal(result.truncated, true);
  assert.equal(messageOf({ jsonPayload: { message: 'json message', code: 7 } }), 'json message (code: 7)');
  assert.equal(messageOf({ jsonPayload: { message: 'error captured', event: { errorType: 'firestore_timeout', requestId: 'r-1' } } }),
    'error captured (errorType: firestore_timeout)');
  // Cloud Run request logs have only httpRequest; the query string never reaches the summary.
  assert.equal(messageOf({ httpRequest: { requestMethod: 'POST', requestUrl: 'https://api-x.a.run.app/v1/jobs?token=secret', status: 503 } }),
    'HTTP 503 POST /v1/jobs');
  assert.equal(messageOf({}), '(no message)');
  assert.equal(messageOf({ protoPayload: { status: { message: 'PERMISSION_DENIED' } } }), 'PERMISSION_DENIED');
  assert.equal(messageOf({ jsonPayload: { code: 7 } }), '{"code":7}');
  assert.equal(summarize([], scope, 0, 1000, false).matchedEntries, 0);
  assert.equal(filterFor(scope, 0, 1000), 'resource.type="cloud_function" AND resource.labels.function_name="checkout" AND ' +
    'severity>=ERROR AND timestamp>="1970-01-01T00:00:00.000Z" AND timestamp<"1970-01-01T00:00:01.000Z"');
  assert.equal(filterFor({ ...scope, resourceType: 'cloud_run_revision' }, 0, 1000).startsWith(
    'resource.type="cloud_run_revision" AND resource.labels.service_name="checkout"'), true);
  assert.throws(() => cloudLoggingTool({ resourceType: 'gce_instance' as never }), /Unsupported resource type/);
});

test('Application Default Credentials map to a short-lived token value', async () => {
  const credential = await gcpCredentials({ getClient: async () => ({ getAccessToken: async () => ({ token: 'ya29.adc' }), credentials: { expiry_date: 4102444800000 } }) })();
  assert.deepEqual(credential, { values: { accessToken: 'ya29.adc' }, expiresAt: 4102444800000 });
  const fallback = await gcpCredentials({ getClient: async () => ({ getAccessToken: async () => ({ token: 'ya29.adc' }) }) })();
  assert.ok(fallback.expiresAt > Date.now() && fallback.expiresAt <= Date.now() + 300000);
  await assert.rejects(gcpCredentials({ getClient: async () => ({ getAccessToken: async () => ({ token: null }) }) }, 1)(), /no access token/);
  let attempts = 0;
  const flaky = await gcpCredentials({ getClient: async () => ({ getAccessToken: async () => {
    if (++attempts === 1) throw Error('Request had insufficient authentication scopes.');
    return { token: 'ya29.second' };
  } }) }, 1)();
  assert.equal(flaky.values.accessToken, 'ya29.second'); assert.equal(attempts, 2);
});

test('a configured log view scopes the request to that view; agents cannot choose one', async () => {
  const context = { subject: 'cloud-logging-codex', executionId: 'x', attemptId: '1', inputDigest: 'x', deadlineMs: Date.now() + 60000, signal: new AbortController().signal };
  const credential = { values: { accessToken: 't' }, expiresAt: Date.now() + 60000 };
  const input = { project: scope.project, resource: scope.resource, startTime: Date.now() - 60000, endTime: Date.now() };
  const bodies: any[] = [];
  const viewed = cloudLoggingOperation({ resourceType: 'cloud_function', logView: 'locations/global/buckets/_Default/views/checkout-errors',
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ entries: [] }); } });
  await viewed.execute(input, credential, context);
  assert.deepEqual(bodies[0].resourceNames, ['projects/ii-demo-checkout/locations/global/buckets/_Default/views/checkout-errors']);
  assert.equal((viewed.inputSchema as { additionalProperties: boolean }).additionalProperties, false);
  for (const logView of ['_Default/checkout-errors', 'locations/global/buckets/_Default/views/x/../../y', 'projects/other/locations/global/buckets/_Default/views/v'])
    assert.throws(() => cloudLoggingOperation({ resourceType: 'cloud_function', logView }), /Invalid log view/);
});

test('upstream failure reasons reach only the trusted host, one capped line without secrets', async () => {
  const now = Date.now(), lines: string[] = [];
  const query = { project: scope.project, resource: scope.resource, startTime: now - 60000, endTime: now };
  const attempt = async (endpoint: string, resolveCredential: () => Promise<{ values: Record<string, string>; expiresAt: number }>) => {
    const gateway = await startGateway({ ...scope, address: '127.0.0.1', fetch: interceptGoogle(endpoint), deadlineMs: now + 60000, signal: new AbortController().signal,
      resolveCredential, model: { respond: async () => new Response(null, { status: 403 }) }, hostLog: line => lines.push(line) });
    try {
      const response = await fetch(`${gateway.endpoint}/tools/cloudLoggingErrors`, { method: 'POST', body: JSON.stringify(query),
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' } });
      return { status: response.status, body: await response.text() };
    } finally { await gateway.close(); }
  };
  const token = async () => ({ values: { accessToken: 'ya29.host-only' }, expiresAt: now + 60000 });
  // A closed port, a Google HTTP 403, and two credential failures whose messages carry secret-shaped text.
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const port = (closed.address() as { port: number }).port; await new Promise<void>(resolve => closed.close(() => resolve()));
  const forbidden = createServer((_req, res) => { res.statusCode = 403; res.end('{"error":{"code":403,"message":"Permission denied on ya29.leak"}}'); });
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening');
  const google = `http://127.0.0.1:${(forbidden.address() as { port: number }).port}`;
  const leaked = 'ya29.a0AfB_byC-secret-access-token-value';
  // Key-shaped test input, assembled at run time so secret scanners don't flag this file.
  const pemBegin = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '), pemEnd = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
  const results = [
    await attempt(`http://127.0.0.1:${port}`, token),
    await attempt(google, token),
    await attempt(google, async () => { throw Error(`Could not refresh access token ${leaked}\n${pemBegin}\nMIIEv\n${pemEnd}`); }),
    await attempt(google, async () => JSON.parse(`{"private_key": "${pemBegin}MIIEvQ`)),
  ];
  forbidden.close();
  // The agent's view: only a generic 502, never the reason.
  for (const result of results) assert.deepEqual(result, { status: 502, body: 'Agent gateway request denied.' });
  assert.deepEqual(lines, ['Cloud Logging endpoint unreachable (ECONNREFUSED)', 'Cloud Logging request failed (HTTP 403)',
    'Google credentials unavailable: Could not refresh access token [redacted] [redacted]',
    'Google credentials unavailable: the credential file is not valid JSON']);
  assert.ok(lines.every(line => !line.includes('ya29') && !line.includes('MIIE') && !line.includes('\n')));
  const long = hostLine(`Google credentials unavailable: ${'word '.repeat(100)}`);
  assert.equal(long.length, 200); assert.ok(long.endsWith('...'));
  assert.equal(hostLine(`token ${'A1b2'.repeat(20)} end`), 'token [redacted] end');
  assert.equal(hostLine('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.'),
    'Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.');
});
