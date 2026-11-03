// npm run demo: seed the upstream floci-gcp emulator with a sample Cloud Run service's logs, then run the real CLI
// read path (`--read`) against it. Needs only Docker: no Google account, no credentials and no model.
// npm run demo -- --keep leaves the seeded emulator running for a live Codex run.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cloudRunService, createFloci } from './floci.js';

let keepRequested = false;
try { keepRequested = parseArgs({ options: { keep: { type: 'boolean' } } }).values.keep ?? false; }
catch { console.error('Usage: npm run demo [-- --keep]'); process.exit(64); }
const project = 'ii-demo-shop', service = 'checkout';
const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../src/cli.ts' : '../src/cli.js', import.meta.url));

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

/** Runs the CLI exactly as `npm start -- ...` does, and returns its exit code and output. */
function runCli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile(process.execPath, [...process.execArgv, cli, ...args], { encoding: 'utf8', timeout: 60000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
}

const floci = createFloci('cloud-logging-demo');
let directory: string | undefined, keep = false;
const cleanup = () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (!keep) floci.remove();
};
const interrupt = () => {
  keep = false;
  try { cleanup(); } catch (error) { console.error(error instanceof Error ? error.message : 'Emulator cleanup failed'); }
  process.exit(130);
};
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

try {
  try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 20000 }); }
  catch (error) {
    throw Error((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'npm run demo needs Docker, and no docker command was found. Install Docker Desktop, or Colima (brew install colima docker, then colima start), and retry.'
      : 'npm run demo needs Docker, but the Docker daemon did not answer. Start Docker Desktop or Colima, then retry.');
  }
  console.log('Cloud Logging errors for Codex: demo (Docker only; no Google account, no model)\n');
  console.log('Starting floci-gcp, an independent Cloud Logging emulator (the first run pulls the image)...');
  await floci.start();
  const entries = sampleEntries(Date.now());
  await floci.api('entries:write', { entries });
  console.log(`Seeded ${entries.length} entries at ${floci.endpoint}:\n` +
    `  7 ERROR/CRITICAL entries from Cloud Run service "${service}" in project ${project}, in the last 40 minutes;\n` +
    '  plus INFO and WARNING entries, an error from 2 days ago, service "payments" and project ii-demo-ledger.\n');

  directory = mkdtempSync(join(tmpdir(), 'cloud-logging-demo-'));
  const config = join(directory, 'config.json');
  const settings = { project, resourceType: 'cloud_run_revision', resource: service, emulatorEndpoint: floci.endpoint };
  writeFileSync(config, JSON.stringify(settings, null, 2));
  console.log(`1. npm start -- --read --minutes 60, with this config.json:\n${JSON.stringify(settings)}\n`);
  const read = await runCli(['--read', '--config', config, '--minutes', '60']);
  process.stdout.write(read.stdout); process.stderr.write(read.stderr);
  const summary = read.code === 0 ? JSON.parse(read.stdout.slice(read.stdout.indexOf('\n{') + 1)) : undefined;
  if (summary?.matchedEntries !== 7) throw Error(`Expected the 7 in-scope entries (CLI exit ${read.code})`);

  console.log('\n2. npm start -- --read --minutes 60 --resource payments');
  const denied = await runCli(['--read', '--config', config, '--minutes', '60', '--resource', 'payments']);
  process.stderr.write(denied.stderr);
  if (denied.code === 0 || !/denied by the gateway grant \(HTTP 403\)/.test(denied.stderr)) throw Error('Expected the gateway to deny another service');

  console.log(`\nThe gateway returned ${summary.matchedEntries} in-scope errors in ${summary.errors.length} groups and denied ` +
    'another service without contacting Cloud Logging.');
  if (keepRequested) {
    keep = true;
    console.log(`\nThe seeded emulator is still running. To try a live Codex run against it (needs OPENAI_API_KEY), set in config.json:
  "project": "${project}",
  "resourceType": "cloud_run_revision",
  "resource": "${service}",
  "emulatorEndpoint": "${floci.endpoint}",
then run: npm run start:linux -- --minutes 1440   (macOS)   or   npm start -- --minutes 1440   (Linux)
Stop the emulator: docker rm -f -v ${floci.name}`);
  } else {
    floci.remove();
    console.log('Removed the emulator and its volume. To keep it running for a live Codex run: npm run demo -- --keep');
  }
} catch (error) {
  keep = false;
  console.error(error instanceof Error ? error.message : 'Demo failed');
  process.exitCode = 1;
} finally {
  try { cleanup(); } catch (error) { console.error(error instanceof Error ? error.message : 'Emulator cleanup failed'); process.exitCode = 1; }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
