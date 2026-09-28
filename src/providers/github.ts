import { createHash } from 'node:crypto';
import type { Observation } from '../checks.js';
import type { SecretReference } from '../setup.js';

export interface GitHubResponse { status: number; body: unknown }
/** The consumer supplies authenticated transport. Tokens never enter runtime records. */
export interface GitHubTransport {
  request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<GitHubResponse>;
}
export function repositoryPath(repository: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Invalid repository');
  return `/repos/${repository}`;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
  return value as Record<string, unknown>;
}
/** Checks named metadata availability only, not workflow eligibility or downstream credential power. */
export async function inspectGitHubSecret(transport: GitHubTransport, reference: SecretReference): Promise<Observation> {
  const unavailable: Observation = { status: 'unknown', evidenceId: 'github:metadata-unavailable' };
  try {
    if (reference.provider !== 'github' || typeof reference.repository !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(reference.key)) return unavailable;
    const base = repositoryPath(reference.repository);
    if (reference.organization !== undefined) {
      if (reference.environment !== undefined || !/^[A-Za-z0-9_-]+$/.test(reference.organization) || reference.organization.toLowerCase() !== reference.repository.split('/')[0]?.toLowerCase()) return unavailable;
      // The repository-scoped inventory proves inheritance without requiring
      // organization-admin access. A repository override changes the source.
      const inherited = await secretInventory(transport, `${base}/actions/organization-secrets`);
      const local = await secretInventory(transport, `${base}/actions/secrets`);
      const metadata = inherited.get(reference.key);
      if (!metadata || local.has(reference.key)) return unavailable;
      const digest = createHash('sha256').update(JSON.stringify([base, reference.organization, reference.key, metadata.updated_at, 'no-repository-override'])).digest('hex');
      return { status: 'verified', evidenceId: `github:organization-secret-metadata:${digest}` };
    }
    if (reference.environment !== undefined && !reference.environment.trim()) return unavailable;
    const path = reference.environment === undefined
      ? `${base}/actions/secrets/${reference.key}`
      : `${base}/environments/${encodeURIComponent(reference.environment)}/secrets/${reference.key}`;
    const response = await transport.request('GET', path);
    // 404 can hide an inaccessible repository; it is not proof that a secret is absent.
    if (response.status !== 200) return unavailable;
    const metadata = object(response.body);
    if (metadata.name !== reference.key || typeof metadata.updated_at !== 'string' || !Number.isFinite(Date.parse(metadata.updated_at))) return unavailable;
    const digest = createHash('sha256').update(JSON.stringify([path, metadata.name, metadata.updated_at])).digest('hex');
    return { status: 'verified', evidenceId: `github:secret-metadata:${digest}` };
  } catch { return unavailable; }
}

async function secretInventory(transport: GitHubTransport, path: string): Promise<Map<string, { updated_at: string }>> {
  const found = new Map<string, { updated_at: string }>();
  let expected: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await transport.request('GET', `${path}?per_page=100&page=${page}`);
    if (response.status !== 200) throw Error('Secret inventory unavailable');
    const body = object(response.body);
    if (!Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0 || !Array.isArray(body.secrets) || body.secrets.length > 100 || (expected !== undefined && expected !== body.total_count)) throw Error('Incomplete secret inventory');
    expected = body.total_count as number;
    for (const value of body.secrets) {
      const item = object(value);
      if (typeof item.name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(item.name) || found.has(item.name) || typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) throw Error('Invalid secret metadata');
      found.set(item.name, { updated_at: item.updated_at });
    }
    if (found.size === expected) return found;
    if (body.secrets.length < 100 || found.size > expected) throw Error('Incomplete secret inventory');
  }
  throw Error('Secret inventory exceeds limit');
}

/** Authentication is injected by the consumer's fetch wrapper; redirects are never followed. */
export function createGitHubTransport(
  authenticatedFetch: typeof fetch, apiBase = 'https://api.github.com', timeoutMs = 30_000,
): GitHubTransport {
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid GitHub API base');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid API timeout');
  const prefix = base.pathname.replace(/\/$/, '');
  return { async request(method, path, body) {
    if (!path.startsWith('/repos/') || path.includes('..') || path.includes('#') || path.includes('\\')) throw new Error('Invalid GitHub API path');
    const url = new URL(base.origin + prefix + path);
    try {
      const response = await authenticatedFetch(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status >= 300 && response.status < 400) throw new Error('redirect');
      // Error payloads may echo sensitive request details. Never retain them.
      if (response.status < 200 || response.status >= 300 || response.status === 204) {
        await response.body?.cancel(); return { status: response.status, body: null };
      }
      return { status: response.status, body: await response.json() };
    } catch { throw new Error('GitHub request failed; remote outcome may be unknown'); }
  } };
}
