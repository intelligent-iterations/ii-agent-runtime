import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { GrantIntent, createAccessLedger } from './access-ledger.js';
import { ingestAppDelivery } from './installation-audit.js';

export interface AppRepositoryPolicy { id: number; permissions: Record<string, 'read' | 'write'> }
export interface GitHubAppConfig {
  appId: number;
  key: { kind: 'keychain'; service: string; account: string } | { kind: 'file'; path: string };
  revision: string;
  approvedBy: string;
  repositories: Record<string, AppRepositoryPolicy>;
}
export type AccessLedger = ReturnType<typeof createAccessLedger>;
const repositoryName = (value: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const b64 = (value: string) => Buffer.from(value).toString('base64url');
const permissionsEqual = (left: Record<string, string>, right: Record<string, string>) => {
  const observed = { ...left };
  if (observed.metadata === 'read' && right.metadata === undefined) delete observed.metadata;
  return JSON.stringify(Object.entries(observed).sort()) === JSON.stringify(Object.entries(right).sort());
};

/** The key is read only on the host, and never returned in configuration or evidence. */
export function loadAppPrivateKey(config: GitHubAppConfig['key']): string {
  if (config.kind === 'keychain') {
    if (process.platform !== 'darwin' || !config.service || !config.account) throw Error('Invalid Keychain reference');
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', config.service, '-a', config.account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32_768 }).trim();
  }
  const stat = lstatSync(config.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Unsafe App private-key file');
  return readFileSync(config.path, 'utf8');
}

export function signAppJwt(appId: number, privateKey: string, now = Date.now()): string {
  if (!Number.isSafeInteger(appId) || appId < 1 || !privateKey.includes('PRIVATE KEY')) throw Error('Invalid App signing input');
  const issued = Math.floor(now / 1000) - 30;
  const input = `${b64('{"alg":"RS256","typ":"JWT"}')}.${b64(JSON.stringify({ iat: issued, exp: issued + 540, iss: appId }))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

export function createGitHubApp(config: GitHubAppConfig, ledger: AccessLedger, options: { fetch?: typeof fetch; privateKey?: () => string } = {}) {
  if (!Number.isSafeInteger(config.appId) || config.appId < 1 || !config.revision || !config.approvedBy ||
      !Object.keys(config.repositories).length) throw Error('Invalid App configuration');
  const request = options.fetch ?? fetch;
  const key = options.privateKey ?? (() => loadAppPrivateKey(config.key));
  async function api(path: string, method: string, credential: string, body?: unknown) {
    if (!path.startsWith('/') || path.startsWith('//')) throw Error('Invalid GitHub API path');
    const response = await request(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
        'x-github-api-version': '2022-11-28' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data: unknown = null;
    if (response.status !== 204) { try { data = await response.json(); } catch { /* A malformed body is handled by the caller. */ } }
    return { status: response.status, data };
  }
  function policy(repository: string, permissions: Record<string, 'read' | 'write'>) {
    if (!repositoryName(repository)) throw Error('Invalid repository');
    const allowed = config.repositories[repository.toLowerCase()];
    if (!allowed || !Number.isSafeInteger(allowed.id) || allowed.id < 1 || !Object.keys(permissions).length) throw Error('Repository is not approved');
    for (const [name, level] of Object.entries(permissions)) {
      const maximum = allowed.permissions[name];
      if (!/^[a-z_]+$/.test(name) || !['read', 'write'].includes(level) || !maximum || (level === 'write' && maximum !== 'write')) throw Error('Permission is not approved');
    }
    return allowed;
  }
  async function syncDeliveries(jwt: string): Promise<number> {
    const listed = await api('/app/hook/deliveries?per_page=100', 'GET', jwt);
    if (listed.status !== 200 || !Array.isArray(listed.data)) throw Error('App webhook delivery inventory unavailable');
    const known = new Set(ledger.installationEvents().map(event => event.eventId.split(':').slice(0, 2).join(':')));
    const candidates = listed.data.filter((entry: unknown) => {
      const item = entry as { id?: unknown; event?: unknown };
      return Number.isSafeInteger(item?.id) && ['installation', 'installation_repositories'].includes(String(item.event)) &&
        !known.has(`app-delivery:${item.id}`);
    }).reverse();
    let recorded = 0;
    for (const candidate of candidates) {
      const id = (candidate as { id: number }).id;
      const detail = await api(`/app/hook/deliveries/${id}`, 'GET', jwt);
      if (detail.status !== 200 || (detail.data as { id?: unknown })?.id !== id) throw Error('App webhook delivery unavailable');
      recorded += ingestAppDelivery(ledger, detail.data);
    }
    return recorded;
  }
  async function issue(input: { repository: string; permissions: Record<string, 'read' | 'write'>; purpose: string; recipient: string; attemptId?: string }) {
    const allowed = policy(input.repository, input.permissions);
    const jwt = signAppJwt(config.appId, key());
    await syncDeliveries(jwt);
    const installation = ledger.latestInstallation(input.repository);
    if (!installation || installation.action !== 'granted') throw Error('Installation actor evidence is missing or access was removed');
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.purpose) || !/^[A-Za-z0-9_.:/@-]{1,240}$/.test(input.recipient)) throw Error('Invalid grant purpose or recipient');
    const intent: GrantIntent = { provider: 'github-app', recipient: input.recipient, resource: input.repository.toLowerCase(),
      capabilities: Object.entries(input.permissions).map(([name, level]) => `${name}:${level}`), authorizedBy: installation.actor,
      issuedBy: `factory-app:${config.appId}:${userInfo().username}`, policyRevision: config.revision,
      attemptId: input.attemptId ?? null, credentialReference: `app:${config.appId}:${input.purpose}` };
    const grantId = ledger.request(intent);
    try {
      const install = await api(`/repos/${input.repository}/installation`, 'GET', jwt);
      const details = install.data as { id?: unknown; updated_at?: unknown; suspended_at?: unknown; repository_selection?: unknown } | null;
      const installationId = details?.id;
      const updated = Date.parse(String(details?.updated_at));
      if (install.status !== 200 || !Number.isSafeInteger(installationId) || installationId !== installation.installationId ||
          !Number.isFinite(updated) || updated > Date.parse(installation.at) + 1_000 ||
          details?.suspended_at !== null || details?.repository_selection !== 'selected')
        throw Error('App installation unavailable, changed, or not limited to selected repositories');
      const minted = await api(`/app/installations/${installationId}/access_tokens`, 'POST', jwt,
        { repository_ids: [allowed.id], permissions: input.permissions });
      const data = minted.data as { token?: unknown; expires_at?: unknown; permissions?: unknown; repositories?: unknown } | null;
      if (minted.status !== 201 || !data || typeof data.token !== 'string' || typeof data.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(data.expires_at)) || !data.permissions || typeof data.permissions !== 'object' ||
          !permissionsEqual(data.permissions as Record<string, string>, input.permissions) ||
          !Array.isArray(data.repositories) || data.repositories.length !== 1 ||
          (data.repositories[0] as { id?: unknown })?.id !== allowed.id) throw Error('Returned App token scope differs from policy');
      ledger.append({ eventId: `${grantId}:issued`, grantId, kind: 'issued', at: new Date().toISOString(),
        capabilities: intent.capabilities, expiresAt: new Date(data.expires_at).toISOString() });
      ledger.append({ eventId: `${grantId}:observed`, grantId, kind: 'observed', at: new Date().toISOString(),
        observation: 'verified', evidenceId: installation.evidenceId });
      return { grantId, token: data.token, expiresAt: data.expires_at, installationId };
    } catch {
      ledger.append({ eventId: `${grantId}:unknown`, grantId, kind: 'observed', at: new Date().toISOString(),
        observation: 'unknown', evidenceId: 'github-issuance-unconfirmed' });
      throw Error('GitHub App grant could not be confirmed');
    }
  }
  async function withToken<T>(input: Parameters<typeof issue>[0], operation: (token: string, grantId: string) => Promise<T>): Promise<T> {
    const grant = await issue(input);
    ledger.append({ eventId: `${grant.grantId}:delivered`, grantId: grant.grantId, kind: 'delivered', at: new Date().toISOString() });
    try { return await operation(grant.token, grant.grantId); }
    finally { await revoke(grant.grantId, grant.token); }
  }
  async function revoke(grantId: string, token: string): Promise<void> {
    const response = await api('/installation/token', 'DELETE', token).catch(() => ({ status: 0 }));
    if (response.status === 204) ledger.append({ eventId: `${grantId}:ended`, grantId,
      kind: 'ended', at: new Date().toISOString(), reason: 'revoked' });
    else ledger.append({ eventId: `${grantId}:revoke-unknown`, grantId,
      kind: 'observed', at: new Date().toISOString(), observation: 'unknown', evidenceId: 'github-revocation-unconfirmed' });
  }
  return { issue, withToken, revoke, policy, syncDeliveries: async () => syncDeliveries(signAppJwt(config.appId, key())) };
}
