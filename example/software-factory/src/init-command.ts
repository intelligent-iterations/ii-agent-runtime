import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGitHubApi, getRecord, record } from '@intelligent-iterations/ii-agent-runtime/github';
import { parseConfigurationFile } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { connectionDirectory, openConnectionStore } from './connection-store.js';
import { openOnboardingBrowser } from './onboarding-browser.js';
import { defaultPolicy } from './defaults.js';
import { hubRecords } from './hub-connection.js';
import { connectHub } from './hub-onboarding.js';
import { commitHubFiles, ensureIssuesEnabled, ensureModelKey, ensureRuntimeReadKey, planHub } from './hub-setup.js';
import { HUB_FORM_PATH, packageSettings, validateHubManifest } from './hub-files.js';
import { compileHubPolicy, hubPolicy } from './hub-policy.js';
import { checkLimits, editLimits } from './limits-editor.js';
import type { HubConnection } from './hub-connection.js';
import { checkModelKey, ModelKeyError } from './model-key.js';
import { createProgress } from './progress.js';
import { colorSupported, decorate, palette } from './style.js';
import { CURRENT_LAYOUT, hubLayout, PRODUCT_NAME } from './identity.js';

const style = palette(colorSupported(process.stdout));
/** Prints plain text; marks, links and details are colored only on a terminal. */
const say = (text: string) => console.log(decorate(text, style));

/** `runtime.json` (or `.yaml`) in the organization's connection directory, when present. */
export function organizationDefaults(directory: string): string | undefined {
  return ['runtime.json', 'runtime.yaml', 'runtime.yml'].map(name => join(directory, name)).find(path => existsSync(path));
}

export interface InitOptions {
  organization?: string; directory?: string; hubRepository?: string; workerImage?: string; workerImageSigner?: string;
  runtimeRepository?: string; runtimeRevision?: string; runtimeConfig?: string;
  /** The runtime source is private: the hub reads it with a read-only deploy key, stored in its layout's secret. */
  privateRuntime?: boolean;
  printUrls?: boolean; callbackPort?: string;
}
export interface InitServices { ghCredential(): Promise<string>; openBrowser(url: string, printOnly: boolean): Promise<void> }

/** One readline per question: nothing echoes a stray prompt while work runs, and Ctrl+C cancels cleanly. */
async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const cancel = new AbortController();
  lines.once('SIGINT', () => cancel.abort());
  try { return await lines.question(decorate(question, style), { signal: cancel.signal }); }
  catch (error) { if (cancel.signal.aborted) throw Error('Cancelled. Rerun example/software-factory/onboard.sh to continue where you left off.'); throw error; }
  finally { lines.close(); }
}
async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await ask(`${question.startsWith('? ') ? '' : '? '}${question} ${fallback ? '(Y/n)' : '(y/N)'} `)).trim();
  return answer ? /^y(es)?$/i.test(answer) : fallback;
}
/** Reads one line without echoing it, for API keys. */
async function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw Error('A hidden prompt needs a terminal');
  process.stdout.write(decorate(question, style));
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  let value = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') { input.off('data', onData); resolve(value); return; }
          if (character === '\u0003') { input.off('data', onData); reject(Error('Cancelled. Rerun example/software-factory/onboard.sh to continue where you left off.')); return; }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character >= ' ') value += character;
        }
      };
      input.on('data', onData);
    });
  } finally { input.setRawMode(false); input.pause(); process.stdout.write('\n'); }
}
async function askKey(): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const raw = await askHidden('? OpenAI API key (input hidden; paste it once, then press Enter): ');
    try {
      const key = checkModelKey(raw);
      if (key.warning) say(`! ${key.warning}`);
      if (await confirm(`Save the key ${key.preview}?`, true)) return key.value;
    } catch (error) { if (!(error instanceof ModelKeyError)) throw error; say(`✗ ${error.message}`); }
  }
  throw Error('No usable OpenAI API key was entered.');
}
/** A new App's pages can briefly 404 on github.com; wait up to about 30 seconds, then open the link regardless. */
async function waitForAppPage(slug: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await fetch(`https://github.com/apps/${encodeURIComponent(slug)}`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (response?.status === 200) return;
    if (attempt === 0) say('Waiting for GitHub to publish the new App...');
    await sleep(2000);
  }
}
const sampleManifest = (connection: HubConnection) => validateHubManifest({ schemaVersion: 2, kind: hubLayout(connection.layout).manifestKind,
  organization: connection.organization, hub: connection.hub, app: { id: connection.app!.id, installationId: connection.app!.installationId } }, hubLayout(connection.layout));
function limitsText(policy: Record<string, any>): string {
  const limits = policy.limits, launch = policy.launchPolicy, dollars = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
  const who = launch.mode === 'maintainer-approval' ? `issues labeled \`${launch.label}\` by someone with ${launch.minimumPermission} access to the named repository`
    : `the issue author, who needs ${launch.minimumPermission} access to the named repository`;
  return [`- Starts for ${who}.`,
    `- Runs Codex ${policy.harness.version} with ${policy.harness.model} for up to ${limits.timeoutMinutes} minutes on a GitHub-hosted runner, on a task branch; it never pushes a default branch.`,
    `- For the whole organization: at most ${limits.maxConcurrent} at once, ${limits.maxRunsPerMonth} runs and ${dollars(limits.maxCostMicrousdPerMonth)} a month (${dollars(limits.maxModelCostMicrousdPerRun)} of model use per run, ${limits.maxRunsPerIssue} ${limits.maxRunsPerIssue === 1 ? 'run' : 'runs'} per issue).`].join('\n');
}

export async function runInit(options: InitOptions, services: InitServices): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive && !options.organization) throw Error('Onboarding requires an interactive terminal, or --organization.');
  if (options.callbackPort !== undefined && !/^[1-9][0-9]{3,4}$/.test(options.callbackPort)) throw Error('Invalid callback port');
  if (!options.runtimeRepository || !options.runtimeRevision) throw Error('The runtime source is required; run example/software-factory/onboard.sh from a checkout, or pass --runtime-repository and --runtime-revision.');
  const port = options.callbackPort === undefined ? 0 : Number(options.callbackPort);
  const progress = createProgress(process.stdout, { color: style.enabled });
  const api = createGitHubApi({ credential: services.ghCredential, maxRequests: 1000 });
  console.log(`${style.bold(`Welcome to ${PRODUCT_NAME}.`)}\n`);
  const user = await getRecord(api, '/user');
  if (typeof user.login !== 'string' || !/^[a-zA-Z0-9-]+$/.test(user.login)) throw Error('Could not verify GitHub identity');
  say(`✓ GitHub CLI signed in as ${user.login}`);
  let organization = options.organization;
  if (!organization) {
    const organizations: string[] = [];
    const response = await api.request('GET', '/user/memberships/orgs?state=active&per_page=100');
    if (response.status !== 200 || !Array.isArray(response.body)) throw Error('Could not list your organizations. Run: gh auth refresh -h github.com -s read:org');
    for (const entry of response.body) {
      const login = record(record(entry).organization).login;
      if (record(entry).role === 'admin' && typeof login === 'string' && /^[a-zA-Z0-9-]+$/.test(login)) organizations.push(login);
    }
    if (!organizations.length) throw Error(`${PRODUCT_NAME} needs an organization you own; your GitHub account owns none.`);
    if (organizations.length === 1) organization = organizations[0]!;
    else {
      say('\nOrganizations you own:');
      organizations.forEach((name, index) => say(`  ${index + 1}. ${name}`));
      for (;;) {
        organization = organizations[Number((await ask('? GitHub organization (number): ')).trim()) - 1];
        if (organization) break;
        say(`✗ Enter a number from 1 to ${organizations.length}.`);
      }
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(organization)) throw Error('Invalid organization');
  organization = organization.toLowerCase();
  say(`✓ Organization: ${organization}\n`);
  const store = openConnectionStore(options.directory ?? connectionDirectory(homedir(), organization));
  const records = hubRecords(store.directory);
  // An organization's own defaults (for example a cheaper model) live beside its connection record, not in the repository.
  const defaults = options.runtimeConfig ?? organizationDefaults(store.directory);
  if (defaults && !options.runtimeConfig) say(`Using this organization's agent defaults from ${defaults}`);
  const runtime = (defaults ? parseConfigurationFile(defaults) : defaultPolicy()) as Record<string, any>;
  try {
    const prompts = interactive ? { pause: async (message: string) => { await ask(message); }, confirm: (question: string) => confirm(question) } : {};
    const connection = await connectHub({ organization, hubName: options.hubRepository ?? CURRENT_LAYOUT.defaultHubRepository }, {
      api, records, legacy: { load: () => store.load(), reset: () => store.reset() }, progress, waitForAppPage,
      browser: name => openOnboardingBrowser(name, { port }), open: url => services.openBrowser(url, options.printUrls === true), ...prompts });
    const hub = connection.hub!;
    // The hub's own durable names: a hub made under the earlier name keeps its folder, workflow and secrets.
    const layout = hubLayout(connection.layout);
    const policyPath = layout.policyPath;
    say('');
    await ensureModelKey(api, hub.repository, { progress, ...(interactive ? { askKey, confirm: (question: string) => confirm(question) } : {}),
      ...(process.env.OPENAI_API_KEY ? { environmentKey: process.env.OPENAI_API_KEY } : {}) });
    const source = { repository: options.runtimeRepository, revision: options.runtimeRevision,
      ...(options.privateRuntime ? { readSshKeySecret: layout.runtimeKeySecret } : {}) };
    if (options.privateRuntime) await ensureRuntimeReadKey(api, options.runtimeRepository, hub.repository, layout, progress);
    // The policy belongs to the user once written: reruns show it and change it only when asked.
    const existing = await api.request('GET', `/repos/${hub.repository}/contents/${policyPath}?ref=${encodeURIComponent(hub.branch)}`);
    if (existing.status !== 200 && existing.status !== 404) throw Error(`Could not read ${policyPath} from ${hub.repository} (HTTP ${existing.status}).`);
    let policy = JSON.parse(hubPolicy(runtime)) as Record<string, any>;
    let writePolicy = existing.status === 404;
    if (existing.status === 200) {
      try {
        policy = JSON.parse(Buffer.from(String(record(existing.body).content), 'base64').toString('utf8'));
        compileHubPolicy(JSON.stringify(policy), sampleManifest(connection), `${organization}/example`);
        checkLimits(policy);
      } catch (error) {
        if (!interactive) throw Error(`${hub.repository}/${policyPath} is not a valid hub policy: ${error instanceof Error ? error.message : error}`);
        say(`! ${hub.repository}/${policyPath} is not a valid hub policy (${error instanceof Error ? error.message : error}). Set the limits again:`);
        policy = await editLimits(JSON.parse(hubPolicy(runtime)), ask, message => say(message));
        writePolicy = true;
      }
    }
    if (interactive) {
      say(`\nAgents${writePolicy ? '' : ` (current settings in ${hub.repository}/${policyPath})`}:\n${limitsText(policy)}`);
      const edit = writePolicy && existing.status === 404 ? !await confirm('Use these limits?', true) : await confirm('Change these limits?', false);
      if (edit) { policy = await editLimits(policy, ask, message => say(message)); writePolicy = true; say(`\nAgents:\n${limitsText(policy)}`); }
    }
    // A customer's own registry copy of the worker image, and the repository whose signed build record it must carry.
    if (options.workerImage) { policy.environment = { ...policy.environment, image: options.workerImage }; writePolicy = true; }
    if (options.workerImageSigner !== undefined) {
      if (options.workerImageSigner) policy.imageVerification = { signerRepository: options.workerImageSigner }; else delete policy.imageVerification;
      writePolicy = true;
    }
    if (!policy.environment?.image) throw Error('Pass your worker image with --worker-image <image@sha256:digest>. Build it from example/software-factory/worker-image/Dockerfile; see example/software-factory/README.md.');
    const image = String(policy.environment.image);
    if (policy.imageVerification?.signerRepository) say(`✓ The hub will verify that ${image.split('@')[0]} was built and signed by ${policy.imageVerification.signerRepository} before using it`);
    const registryLogin = image.startsWith(`ghcr.io/${organization}/`);
    const plan = planHub(connection, runtime, source, { registryLogin, policy: JSON.stringify(policy, null, 2) + '\n' });
    if (registryLogin) {
      // GitHub has no API for a package's Actions access, so a private worker image needs one click by an owner.
      const name = /^ghcr\.io\/[^/]+\/([^@:]+)/.exec(image)?.[1] ?? '';
      const pkg = await api.request('GET', `/orgs/${organization}/packages/container/${encodeURIComponent(name)}`);
      if (pkg.status === 200 && record(pkg.body).visibility !== 'public') {
        say(`! The worker image ${name} is a private package. Give ${hub.repository} Read access under Manage Actions access at ${packageSettings(image)}, or agents cannot start.`);
      } else if (pkg.status === 404) say(`! The worker image ${image} was not found in ${organization}'s packages; build it from example/software-factory/worker-image/Dockerfile and pass --worker-image.`);
    }
    const task = progress.task(`Writing the hub configuration to ${hub.repository}`);
    await ensureIssuesEnabled(api, hub.repository);
    const changed = await commitHubFiles(api, hub.repository, hub.branch, plan.files, writePolicy ? `Configure ${PRODUCT_NAME} limits` : `Configure ${PRODUCT_NAME}`,
      path => path === policyPath && !writePolicy);
    task.done(changed ? `Hub configured: ${hub.repository}` : 'Hub configuration is already up to date');
    console.log(`\n${style.bold(style.green(`${PRODUCT_NAME} is set up.`))}`);
    say(`  Ask for work: https://github.com/${hub.repository}/issues/new?template=${HUB_FORM_PATH.split('/').pop()}`);
    say('  Name a repository and describe the task. The agent replies on the issue and pushes a task branch in that repository.');
    say(`  Runs appear in https://github.com/${hub.repository}/actions. Change limits by rerunning example/software-factory/onboard.sh, or edit ${policyPath} in the hub.`);
  } finally { store.close(); }
}
