export class GitHubError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(`GitHub request failed (${code}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'GitHubError';
  }
}
export interface GitHubResponse { status: number; body: unknown; requestId: string | null }
export interface GitHubApi {
  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<GitHubResponse>;
  readonly requests: number;
}

/** No retries for mutations; callers must reconcile uncertain writes with provider evidence. */
export function createGitHubApi(options: {
  credential: () => string | Promise<string>;
  fetch?: typeof fetch;
  maxRequests?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}): GitHubApi {
  const request = options.fetch ?? fetch;
  const maximum = options.maxRequests ?? 100;
  const maxBytes = options.maxResponseBytes ?? 1048576;
  const timeoutMs = options.timeoutMs ?? 20000;
  if (![maximum, maxBytes, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) || maximum > 1000 || maxBytes > 10485760 || timeoutMs > 60000) throw new GitHubError('INVALID_LIMIT');
  let requests = 0;
  return {
    get requests() { return requests; },
    async request(method, path, body) {
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) throw new GitHubError('INVALID_PATH');
      const url = new URL(path, 'https://api.github.com');
      if (url.origin !== 'https://api.github.com') throw new GitHubError('INVALID_ORIGIN');
      if (++requests > maximum) throw new GitHubError('REQUEST_LIMIT');
      let response: Response;
      try {
        const token = await options.credential();
        if (!token || /[\r\n]/.test(token)) throw new GitHubError('CREDENTIAL');
        response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { throw new GitHubError('TRANSPORT'); }
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, body: null, requestId: response.headers.get('x-github-request-id') };
      const parts: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          received += result.value.length;
          if (received > maxBytes) throw new GitHubError('RESPONSE_LIMIT');
          parts.push(result.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof GitHubError) throw error;
        throw new GitHubError('RESPONSE_TRANSPORT');
      } finally { reader.releaseLock(); }
      let data: unknown = null;
      if (received) {
        try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); }
        catch { throw new GitHubError('RESPONSE_FORMAT', response.status); }
      }
      return { status: response.status, body: data, requestId: response.headers.get('x-github-request-id') };
    },
  };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubError('RESPONSE_SHAPE');
  return value as Record<string, unknown>;
}
export function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new GitHubError('RESPONSE_ID');
  return value as number;
}
export async function getRecord(api: GitHubApi, path: string): Promise<Record<string, unknown>> {
  const result = await api.request('GET', path);
  if (result.status !== 200) throw new GitHubError('HTTP', result.status);
  return record(result.body);
}
