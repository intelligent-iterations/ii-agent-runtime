import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import { prepareLaunchManifest } from './launch-preparation.js';
import { loadAgentManifest } from './agent-manifest.js';
import { startFactory } from './controller.js';
import type { ControllerOptions } from './controller.js';
import type { FactoryConfig } from './index.js';
import { WorkStore } from './store.js';
import { openLocalImage, type LocalImageHandle } from './local-image.js';
import { appRepositoryAcquisition, openFactoryApp } from './factory-app-auth.js';

interface Session { schemaVersion: 1; id: string; state: 'prepared' | 'completed'; names: string[]; configurationDigest: string }
interface LoadedController { default: ControllerOptions; client: FactoryConfig; preflight(): Promise<unknown>; dispose(): void }
export interface LaunchDependencies {
  prepare: typeof prepareLaunchManifest;
  load(path: string, session: string): Promise<LoadedController>;
  start: typeof startFactory;
}
const defaults: LaunchDependencies = {
  prepare: prepareLaunchManifest,
  load: async (path, session) => import(pathToFileURL(path).href + '?session=' + session),
  start: startFactory,
};

function save(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

/** Prepare, provision and execute one durable batch. Interrupted batches retain their approved inputs. */
interface LaunchOptions {
  dependencies?: LaunchDependencies; signal?: AbortSignal; report?: (value: unknown) => void;
}
export async function launchFactory(directory: string, options: LaunchOptions = {}) {
  const root = resolve(directory);
  const installation = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8'));
  const state = resolve(root, installation.directory); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = new WorkStore(join(state, 'launch-lock.sqlite'));
  let owner: string | undefined;
  let imageStore: LocalImageHandle | undefined;
  try {
    owner = lock.acquireController('factory-launch');
    imageStore = await openLocalImage(root);
    return await launchBatch(directory, options);
  } finally {
    try { await imageStore?.close(); } finally {
      try { if (owner) lock.releaseController('factory-launch', owner); } finally { lock.close(); }
    }
  }
}

async function launchBatch(directory: string, options: LaunchOptions) {
  const dependencies = options.dependencies ?? defaults;
  const root = resolve(directory);
  const installationPath = join(root, 'installation.json');
  const installation = JSON.parse(readFileSync(installationPath, 'utf8'));
  if (!installation.agentsSource || !installation.agentsManifest) throw Error('Run the onboarding wizard before launching');
  const state = resolve(root, installation.directory); mkdirSync(state, { recursive: true, mode: 0o700 });
  const sessionPath = join(state, 'launch-session.json');
  const digest = () => createHash('sha256').update(canonicalJson(installation)).update(readFileSync(resolve(root, installation.agentsManifest))).digest('hex');
  let session: Session | undefined = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : undefined;
  if (session && (session.schemaVersion !== 1 || !['prepared', 'completed'].includes(session.state) || !Array.isArray(session.names))) throw Error('Invalid launch recovery state');
  if (!session || session.state === 'completed') {
    options.signal?.throwIfAborted();
    const appHandle = options.dependencies ? undefined : openFactoryApp(installation.appConfigPath, state);
    let prepared: Awaited<ReturnType<typeof prepareLaunchManifest>>;
    try {
      prepared = await dependencies.prepare(readFileSync(resolve(root, installation.agentsSource), 'utf8'), {
        directory: join(state, 'sources'), workflowRepository: installation.repository,
        codexSecret: installation.roles.code.credentialKey, baseSetup: installation.roles.code.setup,
        ...(appHandle ? { acquire: appRepositoryAcquisition(appHandle.app) } : {}),
      });
    } finally { appHandle?.close(); }
    const manifestPath = resolve(root, installation.agentsManifest);
    writeFileSync(manifestPath, prepared.resolved, { mode: 0o600 });
    installation.acceptanceChecksByAgent = prepared.acceptanceChecksByAgent;
    save(installationPath, installation);
    session = { schemaVersion: 1, id: randomUUID(), state: 'prepared', names: prepared.manifest.agents.map(agent => agent.name), configurationDigest: digest() };
    save(sessionPath, session);
  }
  if (session.configurationDigest !== digest()) throw Error('Prepared batch configuration changed; restore the original installation and resolved manifest before recovery');
  const manifest = loadAgentManifest(resolve(root, installation.agentsManifest), {
    workflowRepository: installation.repository, baseSetup: installation.roles.code.setup,
  });
  if (canonicalJson(session.names) !== canonicalJson(manifest.agents.map(agent => agent.name))) throw Error('Prepared batch changed; restore its original resolved manifest');
  options.signal?.throwIfAborted();
  const loaded = await dependencies.load(join(root, 'controller.mjs'), session.id);
  let controller: Awaited<ReturnType<typeof startFactory>> | undefined;
  let handles: ReturnType<Awaited<ReturnType<typeof startFactory>>['spawn']>[] = [];
  const cancel = () => { for (const handle of handles) handle.cancel(); };
  try {
    if (canonicalJson(loaded.client.roles) !== canonicalJson(manifest.roles)) throw Error('Prepared agents differ from the controller configuration');
    await loaded.preflight();
    options.signal?.throwIfAborted();
    controller = await dependencies.start(loaded.default);
    handles = manifest.agents.map(agent => controller!.spawn(`${session!.id}:${agent.name}`, agent.request));
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    options.report?.({ state: 'running', agents: handles.map(handle => handle.inspect()) });
    const outcomes = await Promise.race([
      Promise.allSettled(handles.map(handle => handle.result({ timeoutMs: 24 * 60 * 60 * 1000 }))),
      controller.coordinatorFailed,
    ]);
    const agents = handles.map(handle => handle.inspect());
    if (agents.every(agent => ['succeeded', 'failed', 'cancelled'].includes(agent.state))) {
      session.state = 'completed'; save(sessionPath, session);
    }
    const result = { state: session.state, accepted: outcomes.every(outcome => outcome.status === 'fulfilled'), agents };
    options.report?.(result);
    return result;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    try { await controller?.close(); } finally { loaded.dispose(); }
  }
}
