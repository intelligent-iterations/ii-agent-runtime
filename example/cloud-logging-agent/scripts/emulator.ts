import assert from 'node:assert/strict';
import { filterFor } from '../src/cloud-logging.js';
import { startGateway } from '../src/gateway.js';
import { cloudFunction, createFloci, FLOCI_IMAGE } from './floci.js';

const project = 'ii-demo-checkout', otherProject = 'ii-demo-payments';
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
const floci = createFloci('cloud-logging-example');
try {
  await floci.start();
  const { endpoint, api } = floci;
  const fn = (functionName: string, inProject = project) => cloudFunction(functionName, inProject);
  const log = (inProject: string) => `projects/${inProject}/logs/cloudfunctions.googleapis.com%2Fcloud-functions`;
  // An actual local application exception, written through the Logging API into the emulator.
  function checkout(order: { sku: string; quantity: number }) {
    if (order.quantity <= 0) throw Error(`Invalid quantity ${order.quantity} for SKU ${order.sku}`);
  }
  let message = '';
  try { checkout({ sku: 'book-1', quantity: -1 }); } catch (error) { message = `checkout rejected: ${(error as Error).message}`; }
  const now = Date.now();
  await api('entries:write', { entries: [
    { logName: log(project), resource: fn('checkout'), severity: 'ERROR', textPayload: message, timestamp: new Date(now - 1000).toISOString() },
    { logName: log(project), resource: fn('checkout'), severity: 'INFO', textPayload: 'checkout started', timestamp: new Date(now - 1500).toISOString() },
    { logName: log(project), resource: fn('checkout'), severity: 'ERROR', textPayload: 'stale error outside the window', timestamp: new Date(now - 7200000).toISOString() },
    { logName: log(project), resource: fn('payments'), severity: 'ERROR', textPayload: 'unrelated payments failure', timestamp: new Date(now - 1000).toISOString() },
    { logName: log(otherProject), resource: fn('checkout', otherProject), severity: 'ERROR', textPayload: 'other project failure', timestamp: new Date(now - 1000).toISOString() },
  ] });
  const startTime = now - 3600000, endTime = now + 1000;
  // Record what the emulator itself returns for the exact query, before the adapter's own scope checks.
  const raw = await api('entries:list', { resourceNames: [`projects/${project}`], pageSize: 100,
    filter: filterFor({ project, resourceType: 'cloud_function', resource: 'checkout' }, startTime, endTime) });
  let resolutions = 0;
  gateway = await startGateway({ project, resourceType: 'cloud_function', resource: 'checkout', endpoint, address: '127.0.0.1',
    signal: new AbortController().signal, deadlineMs: now + 60000,
    resolveCredential: async () => { resolutions++; return { values: { accessToken: 'emulator-only-token' }, expiresAt: Date.now() + 60000 }; },
    model: { respond: async () => new Response(null, { status: 403 }) } });
  const query = { project, resource: 'checkout', startTime, endTime };
  const request = (tool: string, data: unknown) => fetch(`${gateway!.endpoint}/tools/${tool}`, { method: 'POST',
    headers: { authorization: `Bearer ${gateway!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const response = await request('cloudLoggingErrors', query);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.matchedEntries, 1, 'only the in-window ERROR for the granted function');
  assert.equal(result.errors[0].message, message);
  assert.ok(result.errors[0].references[0].insertId);
  assert.equal((await request('cloudLoggingErrors', { ...query, resource: 'payments' })).status, 403);
  assert.equal((await request('cloudLoggingErrors', { ...query, project: otherProject })).status, 403);
  assert.equal((await request('deleteLog', { project, logName: 'cloud-functions' })).status, 403);
  assert.equal(resolutions, 1, 'denials must not resolve credentials');
  const after = await api('entries:list', { resourceNames: [`projects/${project}`], pageSize: 100 });
  assert.equal((after.entries ?? []).length, 4, 'all entries in the granted project still exist');
  console.log(JSON.stringify({ environment: `GCP Cloud Logging emulation: ${FLOCI_IMAGE}; no Google credentials; no model`, result,
    // The adapter re-checks scope locally; this shows what the emulator returned before that check.
    emulatorRawMatches: (raw.entries ?? []).map((entry: { textPayload?: string }) => entry.textPayload),
    checks: { permittedRead: 'passed', infoAndStaleExcluded: true, otherFunctionDenied: 'HTTP 403', otherProjectDenied: 'HTTP 403',
      mutationDenied: 'HTTP 403', deniedCredentialResolutions: 0, entriesStillExist: true } }, null, 2));
} finally {
  await gateway?.close();
  floci.remove();
}
