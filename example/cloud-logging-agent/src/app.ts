import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { ToolCredential } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { dockerTofuTarget, executionServices, type Isolation } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { RESOURCE_TYPES, TOOL, type ResourceType } from './cloud-logging.js';
import { checkCodex, readConfig, type Config } from './config.js';
import { gcpCredentials, startGateway } from './gateway.js';
import { loadWorkerFiles } from './worker-files.js';

const HELP = `Cloud Logging errors for Codex

  npm run demo                       check the boundary on your service: a real read, then two denials (no model)
  npm start -- --read --minutes 60   one read through the gateway, printed as JSON (no model)
  npm start -- --minutes 60          Codex reads the errors and summarizes them (Linux; see below)

Trusted config: --config config.json (copy config.example.json and set project, resourceType, resource)
Request: --minutes, --project, --resource (they change the request, never the trusted grant)
Google credentials come from Application Default Credentials on the trusted host.
Codex mode requires Linux, Docker, OpenTofu, sudo firewall access, and OPENAI_API_KEY.
On macOS: npm run start:linux -- --minutes 60 (runs this CLI in a Linux container on Docker).`;

/**
 * Everything that reaches outside this process. The CLI uses the real ones: the global fetch, which calls
 * logging.googleapis.com, and Application Default Credentials. Tests inject replacements that redirect the
 * Google calls to an emulator, so the code under test is the code users run.
 */
export interface Dependencies {
  fetch?: typeof fetch;
  resolveCredential?: () => Promise<ToolCredential>;
  /** One line of output for the user (default: stdout). */
  out?: (line: string) => void;
  /** Trusted-host diagnostics (default: stderr). */
  err?: (line: string) => void;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const disabledModel = { respond: async (_input: unknown): Promise<Response> => new Response('Model disabled', { status: 403 }) };

function grantLine(config: Config) {
  return `Grant: ${TOOL} → projects/${config.project}, ${config.resourceType} ${RESOURCE_TYPES[config.resourceType]}="${config.resource}"` +
    (config.logView ? `, read through ${config.logView}` : '');
}

const toolCall = (gateway: { endpoint: string; token: string }, tool: string, body: unknown) =>
  fetch(`${gateway.endpoint}/tools/${tool}`, { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface Summary {
  matchedEntries: number; truncated: boolean;
  errors: Array<{ count: number; severity: string; message: string; lastSeen: string; references: Array<{ insertId: string; url: string }> }>;
}

/**
 * npm run demo: the boundary, checked on your own service with your own credentials. It makes the read Codex
 * makes, then asks for another service and for a mutation, and shows that both are denied before Google is called.
 */
async function demo(config: Config, minutes: number, deps: Dependencies, signal: AbortSignal): Promise<number> {
  const out = deps.out!, err = deps.err!;
  let googleCalls = 0, credentialUses = 0;
  const google = deps.fetch ?? fetch;
  const credential = deps.resolveCredential ?? gcpCredentials();
  const other = config.resource === 'payments' ? 'billing' : 'payments';
  const gateway = await startGateway({ project: config.project, resourceType: config.resourceType, resource: config.resource,
    ...(config.logView ? { logView: config.logView } : {}), address: '127.0.0.1', signal, deadlineMs: Date.now() + 120000, model: disabledModel,
    fetch: (input, init) => { googleCalls++; return google(input, init); },
    resolveCredential: () => { credentialUses++; return credential(); }, hostLog: err });
  try {
    out('Cloud Logging errors for Codex: boundary check on your service (no model)\n');
    out(grantLine(config));
    const endTime = Date.now();
    const query = { project: config.project, resource: config.resource, startTime: endTime - minutes * 60000, endTime };

    out(`\n1. Read ${config.resource}'s errors from the last ${minutes} minutes, the call Codex makes:`);
    const read = await toolCall(gateway, TOOL, query);
    let readOk = false;
    if (read.ok) {
      const summary = await read.json() as Summary;
      readOk = true;
      out(`   ${plural(summary.matchedEntries, 'ERROR-or-higher entry', 'ERROR-or-higher entries')} in ${plural(summary.errors.length, 'group')}` +
        `${summary.truncated ? ' (truncated)' : ''}.`);
      for (const group of summary.errors.slice(0, 5)) {
        const message = group.message.length > 96 ? `${group.message.slice(0, 93)}...` : group.message;
        out(`   ${String(group.count).padStart(3)} x ${group.severity.padEnd(8)} ${message}`);
        out(`         last ${group.lastSeen}, insertId ${group.references[0]?.insertId ?? '-'}`);
      }
      if (summary.errors.length > 5) out(`   ... and ${summary.errors.length - 5} more groups (npm start -- --read prints them all as JSON).`);
      if (!summary.matchedEntries) out(`   None in this window. Try a longer one: npm run demo -- --minutes 10080`);
    } else out(`   Failed: gateway HTTP ${read.status}${read.status === 502 ? '; the reason is printed above' : ''}.`);

    const before = googleCalls;
    out(`\n2. Read another service, "${other}":`);
    const denied = await toolCall(gateway, TOOL, { ...query, resource: other });
    out(`   ${denied.status === 403 ? 'Denied by the gateway grant (HTTP 403).' : `Unexpected HTTP ${denied.status}.`}`);
    out(`\n3. Delete a log:`);
    const mutation = await toolCall(gateway, 'deleteLog', { project: config.project, logName: 'run.googleapis.com%2Fstderr' });
    out(`   ${mutation.status === 403 ? 'Denied (HTTP 403): the gateway exposes no write operation.' : `Unexpected HTTP ${mutation.status}.`}`);

    // The summary is printed only when it holds.
    if (denied.status !== 403 || mutation.status !== 403 || googleCalls !== before) {
      err('The boundary check failed: a call outside the grant was not denied before reaching Google.'); return 1;
    }
    if (credentialUses > 1) { err('The boundary check failed: the Google credential was resolved for a denied call.'); return 1; }
    out(`\nGoogle received ${plural(googleCalls, 'request')}, all for the granted read; the two denied calls never left this host.`);
    if (!readOk) return 1;
    out('Next, let Codex read the same errors: npm start -- --minutes 1440 (Linux) or npm run start:linux -- --minutes 1440 (macOS).');
    return 0;
  } finally { await gateway.close(); }
}

/** The CLI. Returns the exit code. */
export async function main(argv: string[], deps: Dependencies = {}): Promise<number> {
  const io: Dependencies = { ...deps, out: deps.out ?? (line => { process.stdout.write(`${line}\n`); }),
    err: deps.err ?? (line => { process.stderr.write(`${line}\n`); }) };
  const out = io.out!;
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string', default: 'config.json' },
    minutes: { type: 'string' }, project: { type: 'string' }, resource: { type: 'string' },
    read: { type: 'boolean' }, demo: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { out(HELP); return 0; }
  const config = readConfig(values.config);
  const minutes = Number(values.minutes ?? (values.demo ? '1440' : '60'));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw Error('minutes must be 1-10080 (7 days)');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (values.demo) return await demo(config, minutes, io, controller.signal);
    return await run(config, minutes, values, io, controller.signal);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

async function run(config: Config, minutes: number, values: { project?: string; resource?: string; read?: boolean },
  deps: Dependencies, signal: AbortSignal): Promise<number> {
  const out = deps.out!;
  const endTime = Date.now();
  const query = { project: values.project ?? config.project, resource: values.resource ?? config.resource,
    startTime: endTime - minutes * 60000, endTime };
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let isolation: Isolation | undefined;
  let target: ReturnType<typeof dockerTofuTarget> | undefined;
  let parent: string | undefined;
  try {
    let address = '127.0.0.1';
    let worker;
    const deadlineMs = Date.now() + 900000;
    let model = disabledModel;
    if (!values.read) {
      if (process.platform !== 'linux' || config.execution !== 'local-linux-docker') throw Error(process.platform === 'linux' ? 'Set "execution": "local-linux-docker" in config.json; there is no host-shell fallback'
        : 'Codex runs only on a Linux Docker host. On macOS, use: npm run start:linux -- --minutes 60');
      checkCodex(config);
      if (!process.env.OPENAI_API_KEY) throw Error('Set OPENAI_API_KEY on the trusted host for a Codex run');
      parent = mkdtempSync(join(tmpdir(), 'cloud-logging-agent-'));
      target = dockerTofuTarget({ parent, executablePath: process.env.PATH!, services: executionServices });
      out('Preparing isolated Codex worker...');
      worker = await target.provision({ image: config.image!, cpu: 1, memoryMiB: 2048, timeoutSeconds: 900,
        configurationDigest: `sha256:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}` }, { signal, deadlineMs });
      await loadWorkerFiles(worker);
      const setup = await worker.setup(['npm ci --no-audit --no-fund'], { signal, timeoutMs: 240000 });
      if (setup.exitCode !== 0) throw Error('Worker dependency installation failed');
      isolation = await worker.isolate(); address = isolation.address;
      model = executionServices.codexModelGateway({ model: config.model!, apiKey: () => process.env.OPENAI_API_KEY!, signal,
        limits: { maxModelRequests: 12, maxInputTokensPerRequest: 64000, maxOutputTokensPerRequest: 4000,
          maxModelCostMicrousdPerRun: 2000000, inputMicrousdPerMillionTokens: config.inputMicrousdPerMillionTokens!,
          outputMicrousdPerMillionTokens: config.outputMicrousdPerMillionTokens! } });
    }
    // The token is resolved per call at the gateway and sent only to logging.googleapis.com.
    gateway = await startGateway({ project: config.project, resourceType: config.resourceType as ResourceType, resource: config.resource, address,
      ...(config.logView ? { logView: config.logView } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), signal, deadlineMs,
      resolveCredential: deps.resolveCredential ?? gcpCredentials(), model, hostLog: deps.err! });
    out(grantLine(config));
    out('Provider preflight: unknown (no Cloud Logging inspector); grant enforcement is active.');
    if (values.read) {
      const response = await toolCall(gateway, TOOL, query);
      // Upstream reasons were already printed to stderr on this trusted host; the agent sees only these statuses.
      if (response.status === 403) throw Error(`Request denied by the gateway grant (HTTP 403): only projects/${config.project}, ` +
        `${RESOURCE_TYPES[config.resourceType]}="${config.resource}" is allowed`);
      if (response.status === 502) throw Error('Gateway HTTP 502: the upstream request failed; see the reason above');
      if (!response.ok) throw Error(`Gateway rejected the request (HTTP ${response.status})`);
      out(JSON.stringify(await response.json(), null, 2));
    } else {
      await isolation!.connect(gateway.port);
      out(await worker!.run({ command: 'node', args: ['/workspace/repository/run.mjs'],
        input: JSON.stringify({ endpoint: gateway.endpoint, token: gateway.token, model: config.model, query }),
        timeoutMs: Math.max(1, deadlineMs - Date.now()), maxOutputBytes: 1048576, signal }));
    }
    return 0;
  } finally {
    // Disconnect the worker first; attempt every cleanup even if one fails.
    const errors: unknown[] = [];
    for (const close of [() => isolation?.close(), () => gateway?.close(), () => target?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (parent && !errors.length) rmSync(parent, { recursive: true });
    if (errors.length) throw Error(`Cleanup incomplete; inspect ${parent}`);
  }
}
