import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument, stringify } from 'yaml';

export interface RepositoryAcquisition {
  resolve(repository: string, ref: string): Promise<string>;
  checkout(repository: string, commit: string, directory: string): Promise<void>;
}
const command = async (binary: string, args: string[], cwd?: string) => {
  try {
    return (await promisify(execFile)(binary, args, { cwd, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
      ...(binary === '/usr/bin/git' ? { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } } : {}),
    })).stdout.trim();
  } catch { throw Error(`${binary} could not prepare the source repository; check GitHub access and the requested revision`); }
};

/** Resolve the short user manifest to the existing immutable execution manifest without editing user YAML. */
export async function prepareAgentSources(source: string, options: {
  directory: string; workflowRepository: string; codexSecret: string;
  acquire?: RepositoryAcquisition;
}): Promise<string> {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw Error('Invalid agent YAML');
  const manifest = document.toJS({ maxAliasCount: 0 });
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.agents) || !manifest.agents.length) throw Error('Add at least one agent to agents.yaml');
  const acquire = options.acquire;
  if (!acquire) throw Error('App-backed repository acquisition is required');
  const root = resolve(options.directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw Error('Source directory must be canonical');
  const names = new Set<string>();
  // Validate all destinations before contacting providers.
  for (const agent of manifest.agents) {
    if (typeof agent?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agent.name) ||
        typeof agent?.repository !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(agent.repository)) throw Error('Invalid agent identity');
    if (names.has(agent.name)) throw Error('Duplicate agent name');
    names.add(agent.name);
    if (typeof agent.prompt !== 'string' || !agent.prompt.trim()) throw Error('Agent prompt is required');
    if (agent.ref !== undefined && (typeof agent.ref !== 'string' || !agent.ref.trim() || agent.ref.length > 255)) throw Error('Invalid source revision');
    if (agent.checkout !== undefined || agent.baseCommit !== undefined) throw Error('Launch resolves checkouts and commits automatically; use ref to select a revision');
  }
  for (const agent of manifest.agents) {
    const commit = await acquire.resolve(agent.repository, agent.ref ?? 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Source acquisition returned an invalid commit');
    const identity = createHash('sha256').update(JSON.stringify([agent.repository.toLowerCase(), commit])).digest('hex');
    const checkout = join(root, identity);
    let exists = false;
    try { lstatSync(checkout); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      const staging = mkdtempSync(join(root, 'acquire-'));
      try {
        const destination = join(staging, 'checkout');
        await acquire.checkout(agent.repository, commit, destination);
        await checkCheckout(destination, commit);
        renameSync(destination, checkout);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    await checkCheckout(checkout, commit);
    delete agent.ref;
    agent.checkout = checkout;
    agent.baseCommit = commit;
  }
  manifest.defaults = { codexSecret: options.codexSecret, ...manifest.defaults };
  return stringify(manifest);
}

async function checkCheckout(directory: string, commit: string) {
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw Error('Unsafe source checkout');
  const git = (...args: string[]) => command('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], directory);
  if (await git('rev-parse', 'HEAD') !== commit || await git('status', '--porcelain')) throw Error('Prepared source checkout changed; refusing to reuse it');
  // Force detection of a missing Git directory before it can be mistaken for a parent checkout.
  if (!lstatSync(join(directory, '.git')).isDirectory()) throw Error('Source must own its Git directory');
}
