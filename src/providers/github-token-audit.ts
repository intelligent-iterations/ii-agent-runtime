/** Advisory inspection of the exact repository credential delivered to a worker. */
export interface GitHubTokenAudit {
  status: 'inspected' | 'incomplete';
  tokenType: 'installation' | 'personal-or-user' | 'unknown';
  repository: string;
  visibleRepositories: number;
  warnings: string[];
}

interface Repository { full_name?: unknown; permissions?: { push?: unknown; admin?: unknown } }
type Request = (path: string) => Promise<{ status: number; body: unknown; headers?: { get(name: string): string | null } }>;

function parsePage(body: unknown): { repositories: Repository[]; total?: number } | null {
  if (Array.isArray(body)) return body.every(item => item && typeof item === 'object') ? { repositories: body } : null;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const value = body as { repositories?: unknown; total_count?: unknown };
    if (Array.isArray(value.repositories) && value.repositories.every(item => item && typeof item === 'object') &&
        Number.isSafeInteger(value.total_count) && (value.total_count as number) >= 0) {
      return { repositories: value.repositories, total: value.total_count as number };
    }
  }
  return null;
}

/** Never calls a mutating endpoint. An absence of warnings is not proof of least privilege. */
export async function inspectGitHubRepositoryToken(repository: string, request: Request): Promise<GitHubTokenAudit> {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw Error('Invalid target repository');
  const warnings: string[] = [];
  let tokenType: GitHubTokenAudit['tokenType'] = 'unknown';
  let path = '/installation/repositories';
  let first: Awaited<ReturnType<Request>>;
  try { first = await request(path + '?per_page=100&page=1'); }
  catch { return { status: 'incomplete', tokenType, repository, visibleRepositories: 0, warnings: ['GitHub credential scope could not be inspected.'] }; }
  if (first.status === 200) tokenType = 'installation';
  else if ([401, 403, 404].includes(first.status)) {
    tokenType = 'personal-or-user';
    path = '/user/repos?affiliation=owner,collaborator,organization_member&visibility=all';
    try { first = await request(path + '&per_page=100&page=1'); }
    catch { return { status: 'incomplete', tokenType, repository, visibleRepositories: 0, warnings: ['GitHub credential scope could not be inspected.'] }; }
  } else return { status: 'incomplete', tokenType, repository, visibleRepositories: 0, warnings: ['GitHub credential scope could not be inspected.'] };
  if (first.status !== 200) return { status: 'incomplete', tokenType, repository, visibleRepositories: 0, warnings: ['GitHub credential scope could not be inspected.'] };
  const scopes = first.headers?.get('x-oauth-scopes');
  if (scopes?.split(',').map(scope => scope.trim()).includes('repo')) warnings.push('Classic PAT has broad repo scope; use a selected-repository fine-grained PAT or scoped GitHub App token.');
  const found = new Map<string, Repository>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    let response: Awaited<ReturnType<Request>>;
    try { response = page === 1 ? first : await request(path + (tokenType === 'installation' ? '?' : '&') + `per_page=100&page=${page}`); }
    catch { warnings.push('Repository inventory is incomplete.'); break; }
    if (response.status !== 200) { warnings.push('Repository inventory is incomplete.'); break; }
    const parsed = parsePage(response.body);
    if (!parsed || (total !== undefined && parsed.total !== undefined && parsed.total !== total)) { warnings.push('Repository inventory is incomplete.'); break; }
    if (parsed.total !== undefined) total = parsed.total;
    for (const repo of parsed.repositories) {
      if (typeof repo.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name)) { warnings.push('Repository inventory is incomplete.'); continue; }
      found.set(repo.full_name.toLowerCase(), repo);
    }
    if (parsed.repositories.length < 100) break;
    if (page === 10) warnings.push('Repository inventory exceeds the inspection limit.');
  }
  if (total !== undefined && found.size !== total) warnings.push('Repository inventory is incomplete.');
  if (!found.has(repository.toLowerCase())) warnings.push(`Credential did not list the assigned repository ${repository}; source access is unverified.`);
  const other = [...found.entries()].filter(([name, repo]) => name !== repository.toLowerCase() && (repo.permissions?.push === true || repo.permissions?.admin === true));
  if (other.length) {
    const examples = other.slice(0, 5).map(([name]) => name).join(', ');
    warnings.push(`GitHub reports possible write access outside ${repository}: ${examples}${other.length > 5 ? ` and ${other.length - 5} more` : ''}. Repository permissions may describe the account rather than the token; verify token grants in GitHub.`);
  }
  if (found.size > 1 && !other.length) warnings.push(`Credential can list ${found.size} repositories; per-repository write scope is not proven by this API.`);
  return { status: warnings.some(warning => warning.includes('incomplete') || warning.includes('could not') || warning.includes('unverified')) ? 'incomplete' : 'inspected', tokenType, repository, visibleRepositories: found.size, warnings };
}

/** Fixed GitHub origin, no redirects, and a bounded request; never include token in an error. */
export function githubTokenRequest(token: string): Request {
  return async path => {
    if (!path.startsWith('/') || path.startsWith('//')) throw Error('Invalid GitHub API path');
    const response = await fetch('https://api.github.com' + path, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (response.status !== 200) return { status: response.status, body: null, headers: response.headers };
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}
