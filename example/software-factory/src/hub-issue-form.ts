import type { IssueRequestReader } from '@intelligent-iterations/ii-agent-runtime/pipeline';

/**
 * Reads the target from the hub's issue form. The body must have the form's exact layout: it starts with the one
 * "### Repository" section, followed by "### Task". Anything that could hide a second target from a reviewer (another
 * Repository heading, an HTML comment) is refused. A bare name means the hub's own organization.
 */
export function parseTargetRepository(body: unknown, organization: string): string | undefined {
  if (typeof body !== 'string' || /<!--/.test(body) || (body.match(/^[ \t]*#{1,6}[ \t]*Repository\b/gim) ?? []).length !== 1) return undefined;
  const match = /^### Repository[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*([^\r\n<>]+?)[ \t]*\r?\n(?:[ \t]*\r?\n)*### (?:Pull request into|Task)[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match) return undefined;
  const value = match[1]!.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').toLowerCase();
  const name = value.includes('/') ? value : `${organization.toLowerCase()}/${value}`;
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(name) || name.length > 140 || name.split('/')[0] !== organization.toLowerCase()) return undefined;
  return name;
}

/**
 * Reads the optional "### Pull request into" section: the branch the agent works from and opens its pull request
 * against. An empty answer means the repository's default branch. Returns null when the value is not a safe branch name.
 */
export function parseBaseBranch(body: unknown): string | undefined | null {
  if (typeof body !== 'string') return undefined;
  if ((body.match(/^[ \t]*#{1,6}[ \t]*Pull request into\b/gim) ?? []).length > 1) return null;
  const match = /^### Pull request into[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*([^\r\n]*?)[ \t]*(?:\r?\n|$)/m.exec(body);
  if (!match || !match[1] || match[1] === '_No response_') return undefined;
  const branch = match[1].replace(/^refs\/heads\//, '');
  const safe = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(branch) && !branch.includes('..') && !branch.includes('//') &&
    !branch.endsWith('/') && !branch.endsWith('.lock') && !branch.endsWith('.');
  return safe ? branch : null;
}

/** What the runtime's hub intake reads from an issue: the repository and base branch this form names. */
export function hubRequestReader(organization: string): IssueRequestReader {
  return body => ({ repository: parseTargetRepository(body, organization), base: parseBaseBranch(body) });
}
