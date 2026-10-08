import { createPrivateKey, createSign } from 'node:crypto';
import { canonicalJson } from '../../../runtime/configuration.js';
import { createGitHubApi, getRecord, GitHubError, positiveId, record } from './http.js';

export type RepositoryPermissions = Partial<Record<'contents' | 'issues' | 'pull_requests', 'read' | 'write'>>;
export interface InstallationToken {
  token: string;
  repository: string;
  repositoryId: number;
  expiresAt: string;
  permissions: RepositoryPermissions;
}
export function appJwt(appId: number, pem: string, now = Date.now()): string {
  positiveId(appId);
  if (!Number.isSafeInteger(now) || !pem || Buffer.byteLength(pem) > 32768) throw new GitHubError('APP_CREDENTIAL');
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new GitHubError('APP_KEY_TYPE');
    const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 540, iss: appId })).toString('base64url');
    const signed = `${header}.${payload}`;
    return `${signed}.${createSign('RSA-SHA256').update(signed).sign(key).toString('base64url')}`;
  } catch { throw new GitHubError('APP_CREDENTIAL'); }
}

/**
 * App key remains in this trusted closure; only scoped installation tokens leave it. `owner` is the organization or
 * user account the App is installed on. The App may belong to someone else (for example a vendor's App installed by
 * customers); `requireAppOwner` additionally requires the App itself to belong to `owner`.
 */
export function createInstallationIssuer(options: {
  appId: number; installationId: number; owner: string; requireAppOwner?: boolean; privateKey: () => string;
  fetch?: typeof fetch; now?: () => number;
}) {
  positiveId(options.appId); positiveId(options.installationId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(options.owner)) throw new GitHubError('OWNER');
  const owner = options.owner.toLowerCase();
  const now = options.now ?? Date.now;
  const api = createGitHubApi({ credential: () => appJwt(options.appId, options.privateKey(), now()),
    ...(options.fetch ? { fetch: options.fetch } : {}), maxRequests: 100 });
  const issued = new Set<string>();
  async function revoke(token: string): Promise<void> {
    const scoped = createGitHubApi({ credential: () => token, ...(options.fetch ? { fetch: options.fetch } : {}), maxRequests: 1 });
    const response = await scoped.request('DELETE', '/installation/token');
    if (response.status !== 204) throw new GitHubError('REVOCATION_UNCONFIRMED', response.status);
    issued.delete(token);
  }
  async function verifyInstallation(): Promise<void> {
    const app = await getRecord(api, '/app');
    if (app.id !== options.appId) throw new GitHubError('APP_IDENTITY');
    if (options.requireAppOwner && String(record(app.owner).login).toLowerCase() !== owner) throw new GitHubError('APP_OWNER');
    const installation = await getRecord(api, `/app/installations/${options.installationId}`);
    const account = record(installation.account);
    if (installation.id !== options.installationId || installation.app_id !== options.appId || installation.suspended_at !== null ||
      !['Organization', 'User'].includes(String(account.type)) || String(account.login).toLowerCase() !== owner ||
      !['all', 'selected'].includes(String(installation.repository_selection))) throw new GitHubError('INSTALLATION');
  }
  async function issue(repository: string, permissions: RepositoryPermissions): Promise<InstallationToken> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository) ||
      repository.split('/')[0]!.toLowerCase() !== owner) throw new GitHubError('REPOSITORY');
    if (!Object.keys(permissions).length || Object.entries(permissions).some(([name, level]) =>
      !['contents', 'issues', 'pull_requests'].includes(name) || !['read', 'write'].includes(level))) throw new GitHubError('PERMISSIONS');
    await verifyInstallation();
    const response = await api.request('POST', `/app/installations/${options.installationId}/access_tokens`,
      { repositories: [repository.split('/')[1]], permissions });
    if (response.status !== 201) throw new GitHubError('ISSUANCE', response.status);
    const value = record(response.body);
    const token = typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 16384 ? value.token : undefined;
    if (!token) throw new GitHubError('TOKEN');
    issued.add(token);
    try {
      const actual = record(value.permissions);
      if (actual.metadata === 'read') delete actual.metadata;
      const repositories = value.repositories;
      if (!Array.isArray(repositories) || repositories.length !== 1 || canonicalJson(actual) !== canonicalJson(permissions)) throw new GitHubError('TOKEN_SCOPE');
      const selected = record(repositories[0]);
      if (String(selected.full_name).toLowerCase() !== repository.toLowerCase()) throw new GitHubError('TOKEN_REPOSITORY');
      const expires = Date.parse(String(value.expires_at));
      if (!Number.isFinite(expires) || expires <= now() + 60000 || expires > now() + 3660000) throw new GitHubError('TOKEN_EXPIRY');
      const grant: InstallationToken = { token, repository: repository.toLowerCase(), repositoryId: positiveId(selected.id),
        expiresAt: new Date(expires).toISOString(), permissions: structuredClone(permissions) };
      return grant;
    } catch (error) {
      // A returned over-broad token must be revoked even if validation fails.
      await revoke(token);
      throw error;
    }
  }
  async function close(): Promise<void> {
    const outcomes = await Promise.allSettled([...issued.keys()].map(revoke));
    if (outcomes.some(result => result.status === 'rejected')) throw new GitHubError('REVOCATION_UNCONFIRMED');
  }
  return { issue, revoke, close, verifyInstallation };
}
