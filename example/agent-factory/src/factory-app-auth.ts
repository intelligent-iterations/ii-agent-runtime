import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAccessLedger } from './access-ledger.js';
import { createGitHubApp, type GitHubAppConfig } from './github-app.js';
import type { RepositoryAcquisition } from './agent-preparation.js';

/** Local App/key reference. Its path stays outside the distributed checkout. */
export function loadFactoryAppConfig(path: string): GitHubAppConfig {
  const location = resolve(path);
  const stat = lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) || realpathSync(location) !== location) throw Error('Unsafe local App configuration');
  const value = JSON.parse(readFileSync(location, 'utf8')) as GitHubAppConfig;
  if (!value || !Number.isSafeInteger(value.appId) || !value.key || !value.repositories ||
      typeof value.revision !== 'string' || typeof value.approvedBy !== 'string') throw Error('Invalid local App configuration');
  return value;
}

function permissionsFor(method: string, path: string): Record<string, 'read' | 'write'> {
  const mutating = method !== 'GET';
  if (/\/actions\/runners(?:\/|$)/.test(path)) return { administration: mutating ? 'write' : 'read' };
  if (/\/actions\/secrets(?:\/|$)/.test(path)) return { secrets: mutating ? 'write' : 'read' };
  if (/\/actions\//.test(path)) return { actions: mutating ? 'write' : 'read' };
  if (/\/(git|contents)\//.test(path)) return mutating ? { contents: 'write', workflows: 'write' } : { contents: 'read' };
  return { metadata: 'read' };
}

/** Issue an operation-scoped factory token for each GitHub REST call. */
export function appAuthenticatedFetch(app: ReturnType<typeof createGitHubApp>, repository: string, request: typeof fetch = fetch): typeof fetch {
  return async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://api.github.com' ||
        !parsed.pathname.startsWith(`/repos/${repository}/` ) && parsed.pathname !== `/repos/${repository}`) throw Error('Factory GitHub request escaped its repository');
    const method = String(init?.method ?? 'GET').toUpperCase();
    const permissions = permissionsFor(method, parsed.pathname);
    return app.withToken({ repository, permissions, purpose: `factory-${method.toLowerCase()}`,
      recipient: 'host:factory-api' }, token => request(url, { ...init, redirect: 'error',
      headers: { ...init?.headers, authorization: `Bearer ${token}` } }));
  };
}

/** A target source token exists only for the resolve or clone operation. */
export function appRepositoryAcquisition(app: ReturnType<typeof createGitHubApp>): RepositoryAcquisition {
  return {
    async resolve(repository, ref) {
      return app.withToken({ repository, permissions: { contents: 'read' }, purpose: 'source-resolve', recipient: 'host:source' }, async token => {
        const response = await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
          redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
        if (response.status !== 200) throw Error('Source revision unavailable');
        const body = await response.json() as { sha?: unknown };
        if (typeof body.sha !== 'string' || !/^[a-f0-9]{40}$/.test(body.sha)) throw Error('Invalid source revision');
        return body.sha;
      });
    },
    async checkout(repository, commit, directory) {
      await app.withToken({ repository, permissions: { contents: 'read' }, purpose: 'source-clone', recipient: 'host:source' }, async token => {
        const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: resolve(directory, '..'), GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` };
        const git = async (args: string[], cwd?: string) => {
          try { await promisify(execFile)('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', ...args],
            { cwd, env, timeout: 300_000, maxBuffer: 1024 * 1024 }); }
          catch { throw Error('App-backed source checkout failed'); }
        };
        await git(['clone', '--no-checkout', '--', `https://github.com/${repository}.git`, directory]);
        await git(['checkout', '--detach', commit], directory);
      });
    },
  };
}

export function openFactoryApp(configPath: string, stateDirectory: string) {
  const ledger = createAccessLedger(resolve(stateDirectory, 'access'));
  try {
    const config = loadFactoryAppConfig(configPath);
    const app = createGitHubApp(config, ledger);
    return { app, ledger, config, close: () => ledger.close(), policyDigest: createHash('sha256').update(JSON.stringify(config.repositories)).digest('hex') };
  } catch (error) { ledger.close(); throw error; }
}
