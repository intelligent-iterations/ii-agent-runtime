// npm run test:demo: runs the real demo and the real read path (src/app.ts, the code `npm run demo` and `npm start`
// run) with their Google Cloud Logging requests redirected to the upstream floci-gcp emulator. Needs Docker only:
// no Google account, no credentials and no model. The emulator exists only here; the CLI always calls Google.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/app.js';
import { filterFor } from '../src/cloud-logging.js';
import { interceptGoogle, testCredential } from '../test/intercept-google.js';
import { cloudRunService, createFloci, FLOCI_IMAGE } from './floci.js';

const project = 'ii-demo-shop', service = 'checkout';

/** A small, realistic sample for one Cloud Run service. Only the first 7 entries are in scope for the grant. */
function sampleEntries(now: number) {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60000).toISOString();
  const log = (inProject: string) => `projects/${inProject}/logs/run.googleapis.com%2Fstderr`;
  const checkout = cloudRunService(service, project);
  const stripe = (orderId: string) => ({ message: 'Stripe API timeout after 10000 ms (POST /v1/payment_intents)', orderId });
  const inventory = 'Inventory read failed: 4 DEADLINE_EXCEEDED: Deadline exceeded after 5.000s (sku book-1)';
  return [
    { severity: 'ERROR', timestamp: at(4), jsonPayload: stripe('ord_8812') },
    { severity: 'ERROR', timestamp: at(11), jsonPayload: stripe('ord_8790') },
    { severity: 'ERROR', timestamp: at(23), jsonPayload: stripe('ord_8771') },
    { severity: 'ERROR', timestamp: at(7), textPayload: inventory },
    { severity: 'ERROR', timestamp: at(31), textPayload: inventory },
    { severity: 'CRITICAL', timestamp: at(15),
      textPayload: "Unhandled rejection: TypeError: Cannot read properties of undefined (reading 'priceCents') at cartTotal (/app/src/cart.js:14:31)" },
    { severity: 'ERROR', timestamp: at(38),
      jsonPayload: { message: 'Webhook signature verification failed: no signatures found matching the expected signature', event: 'payment_intent.succeeded' } },
    // Not in scope: lower severity, outside the window, another service, another project.
    { severity: 'INFO', timestamp: at(5), textPayload: 'POST /checkout 200 412 ms' },
    { severity: 'WARNING', timestamp: at(4), textPayload: 'Retrying Stripe request (attempt 2 of 3)' },
    { severity: 'ERROR', timestamp: at(2 * 24 * 60), textPayload: 'Database connection refused: connect ECONNREFUSED 10.0.0.5:5432' },
    { severity: 'ERROR', timestamp: at(6), textPayload: 'Card authorization handler crashed', resource: cloudRunService('payments', project) },
    { severity: 'ERROR', timestamp: at(6), textPayload: 'Ledger export failed', inProject: 'ii-demo-ledger' },
  ].map(({ inProject = project, resource = inProject === project ? checkout : cloudRunService(service, inProject), ...entry }) =>
    ({ logName: log(inProject), resource, ...entry }));
}

try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 20000 }); }
catch (error) {
  console.error((error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'npm run test:demo needs Docker, and no docker command was found. Install Docker Desktop, or Colima (brew install colima docker, then colima start), and retry.'
    : 'npm run test:demo needs Docker, but the Docker daemon did not answer. Start Docker Desktop or Colima, then retry.');
  process.exit(1);
}

const floci = createFloci('cloud-logging-test-demo');
const directory = mkdtempSync(join(tmpdir(), 'cloud-logging-test-demo-'));
const interrupt = () => { try { floci.remove(); } finally { process.exit(130); } };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  console.log(`Starting ${FLOCI_IMAGE} (the first run pulls the image)...`);
  await floci.start();
  const now = Date.now(), entries = sampleEntries(now);
  await floci.api('entries:write', { entries });
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ project, resourceType: 'cloud_run_revision', resource: service }));

  let credentials = 0;
  const seen: string[] = [];
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main([...args, '--config', config], { fetch: interceptGoogle(floci.endpoint, seen), out: l => out.push(l), err: l => err.push(l),
      resolveCredential: () => { credentials++; return testCredential(); } });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  // 1. The demo itself, exactly as `npm run demo` runs it.
  const demo = await run(['--demo', '--minutes', '60']);
  console.log(`\n--- npm run demo, with Google calls redirected to ${floci.endpoint} ---\n${demo.out}\n---\n`);
  assert.equal(demo.code, 0, demo.err);
  assert.match(demo.out, /7 ERROR-or-higher entries in 4 groups\./);
  assert.match(demo.out, /Denied by the gateway grant \(HTTP 403\)\./);
  assert.match(demo.out, /Denied \(HTTP 403\): the gateway exposes no write operation\./);
  assert.match(demo.out, /Google received 1 request, all for the granted read/);
  assert.deepEqual(seen, ['/v2/entries:list']); assert.equal(credentials, 1);

  // 2. The read path, as `npm start -- --read` runs it, and requests outside the grant.
  const read = await run(['--read', '--minutes', '60']);
  const summary = JSON.parse(read.out.slice(read.out.indexOf('\n{') + 1));
  assert.equal(summary.matchedEntries, 7, 'only in-window ERROR+ entries of the granted service');
  assert.deepEqual(summary.errors.map((group: { count: number }) => group.count), [3, 2, 1, 1]);
  assert.ok(summary.errors.every((group: { references: Array<{ insertId: string }> }) => group.references[0]?.insertId));
  for (const args of [['--resource', 'payments'], ['--project', 'ii-demo-ledger']])
    await assert.rejects(run(['--read', '--minutes', '60', ...args]), /denied by the gateway grant \(HTTP 403\)/);
  assert.equal(seen.length, 2, 'denied requests never reach the emulator'); assert.equal(credentials, 2, 'denied requests never resolve a credential');

  // What the emulator returns for the exact query, before the adapter's own scope check: it ignores resource.labels.
  const raw = await floci.api('entries:list', { resourceNames: [`projects/${project}`], pageSize: 100,
    filter: filterFor({ project, resourceType: 'cloud_run_revision', resource: service }, now - 3600000, now + 1000) });
  const after = await floci.api('entries:list', { resourceNames: [`projects/${project}`], pageSize: 100 });
  assert.equal((after.entries ?? []).length, entries.filter(entry => entry.logName.includes(`/${project}/`)).length, 'nothing was deleted');
  console.log(JSON.stringify({ environment: `Cloud Logging requests redirected to ${FLOCI_IMAGE}; no Google credentials; no model`,
    checks: { demo: 'passed', inScopeEntries: summary.matchedEntries, groups: summary.errors.length, otherServiceDenied: 'HTTP 403',
      otherProjectDenied: 'HTTP 403', mutationDenied: 'HTTP 403', deniedRequestsReachingGoogle: 0, entriesStillExist: true,
      emulatorRawMatchesBeforeScopeCheck: (raw.entries ?? []).length } }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
  floci.remove();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
