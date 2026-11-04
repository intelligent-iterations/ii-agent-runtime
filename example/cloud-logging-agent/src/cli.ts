import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { dockerTofuTarget, executionServices, type Isolation } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { RESOURCE_TYPES, TOOL } from './cloud-logging.js';
import { checkCodex, readConfig } from './config.js';
import { gcpCredentials, startGateway } from './gateway.js';
import { loadWorkerFiles } from './worker-files.js';

const HELP = `Cloud Logging errors for Codex

  npm start -- --minutes 60
  npm start -- --read --minutes 60   (gateway-only smoke test; no model)
  npm run demo                       (seeded local emulator; Docker only, no Google account)

Trusted config: --config config.json
Request: --project, --resource (change the request, never the trusted grant)
Google credentials come from Application Default Credentials on the trusted host.
Codex mode requires Linux, Docker, OpenTofu, sudo firewall access, and OPENAI_API_KEY.
On macOS: npm run start:linux -- --minutes 60 (runs this CLI in a Linux container on Docker).`;

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string', default: 'config.json' },
    minutes: { type: 'string', default: '60' }, project: { type: 'string' }, resource: { type: 'string' },
    read: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { console.log(HELP); return; }
  const config = readConfig(values.config);
  const { resourceType, emulator } = config;
  const minutes = Number(values.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw Error('minutes must be 1-10080 (7 days)');
  const endTime = Date.now();
  const query = { project: values.project ?? config.project, resource: values.resource ?? config.resource,
    startTime: endTime - minutes * 60000, endTime };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let isolation: Isolation | undefined;
  let target: ReturnType<typeof dockerTofuTarget> | undefined;
  let parent: string | undefined;
  try {
    let address = '127.0.0.1';
    let worker;
    const deadlineMs = Date.now() + 900000;
    let model = { respond: async (_input: unknown): Promise<Response> => new Response('Model disabled', { status: 403 }) };
    if (!values.read) {
      if (process.platform !== 'linux' || config.execution !== 'local-linux-docker') throw Error(process.platform === 'linux' ? 'Set "execution": "local-linux-docker" in config.json; there is no host-shell fallback'
        : 'Codex runs only on a Linux Docker host. On macOS, use: npm run start:linux -- --minutes 60');
      checkCodex(config);
      if (!process.env.OPENAI_API_KEY) throw Error('Set OPENAI_API_KEY on the trusted host for a Codex run');
      parent = mkdtempSync(join(tmpdir(), 'cloud-logging-agent-'));
      target = dockerTofuTarget({ parent, executablePath: process.env.PATH!, services: executionServices });
      console.log('Preparing isolated Codex worker...');
      worker = await target.provision({ image: config.image!, cpu: 1, memoryMiB: 2048, timeoutSeconds: 900,
        configurationDigest: `sha256:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}` }, { signal: controller.signal, deadlineMs });
      await loadWorkerFiles(worker);
      const setup = await worker.setup(['npm ci --no-audit --no-fund'], { signal: controller.signal, timeoutMs: 240000 });
      if (setup.exitCode !== 0) throw Error('Worker dependency installation failed');
      isolation = await worker.isolate(); address = isolation.address;
      model = executionServices.codexModelGateway({ model: config.model!, apiKey: () => process.env.OPENAI_API_KEY!, signal: controller.signal,
        limits: { maxModelRequests: 12, maxInputTokensPerRequest: 64000, maxOutputTokensPerRequest: 4000,
          maxModelCostMicrousdPerRun: 2000000, inputMicrousdPerMillionTokens: config.inputMicrousdPerMillionTokens!,
          outputMicrousdPerMillionTokens: config.outputMicrousdPerMillionTokens! } });
    }
    // Emulator mode never uses Google credentials; live mode never sends the token anywhere but logging.googleapis.com.
    const resolveCredential = emulator
      ? async () => ({ values: { accessToken: 'emulator-only-token' }, expiresAt: Date.now() + 300000 })
      : gcpCredentials();
    gateway = await startGateway({ project: config.project, resourceType, resource: config.resource, address,
      ...(emulator ? { endpoint: emulator } : {}), ...(config.logView ? { logView: config.logView } : {}), signal: controller.signal, deadlineMs, resolveCredential, model });
    console.log(`Grant: ${TOOL} → projects/${config.project}, ${resourceType} ${RESOURCE_TYPES[resourceType]}="${config.resource}"` +
      (config.logView ? `, read through ${config.logView}` : ''));
    if (emulator) console.log(`EMULATOR MODE: Cloud Logging at ${emulator}; no Google credentials are used.`);
    for (const notice of config.notices) console.log(notice);
    console.log('Provider preflight: unknown (no Cloud Logging inspector); grant enforcement is active.');
    if (values.read) {
      const response = await fetch(`${gateway.endpoint}/tools/${TOOL}`, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify(query) });
      // Upstream reasons were already printed to stderr on this trusted host; the agent sees only these statuses.
      if (response.status === 403) throw Error(`Request denied by the gateway grant (HTTP 403): only projects/${config.project}, ` +
        `${RESOURCE_TYPES[resourceType]}="${config.resource}" is allowed`);
      if (response.status === 502) throw Error('Gateway HTTP 502: the upstream request failed; see the reason above');
      if (!response.ok) throw Error(`Gateway rejected the request (HTTP ${response.status})`);
      console.log(JSON.stringify(await response.json(), null, 2));
    } else {
      await isolation!.connect(gateway.port);
      console.log(await worker!.run({ command: 'node', args: ['/workspace/repository/run.mjs'],
        input: JSON.stringify({ endpoint: gateway.endpoint, token: gateway.token, model: config.model, query }),
        timeoutMs: Math.max(1, deadlineMs - Date.now()), maxOutputBytes: 1048576, signal: controller.signal }));
    }
  } finally {
    // Disconnect the worker first; attempt every cleanup even if one fails.
    const errors: unknown[] = [];
    for (const close of [() => isolation?.close(), () => gateway?.close(), () => target?.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (parent && !errors.length) rmSync(parent, { recursive: true });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (errors.length) throw Error(`Cleanup incomplete; inspect ${parent}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Cloud Logging run failed'); process.exitCode = 1; });
