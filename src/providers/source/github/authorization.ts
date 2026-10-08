import { canonicalJson, digest } from '../../../runtime/configuration.js';
import { GitHubError, positiveId, record } from './http.js';

export interface ActionsIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
  attempt: number;
  workflowSha: string;
}
const roles = ['read', 'triage', 'write', 'maintain', 'admin'];
export function capabilitiesForPermission(permission: unknown, roleName: unknown): string[] {
  const baseRole: Record<string, string> = { read: 'read', triage: 'read', write: 'write', maintain: 'write', admin: 'admin' };
  if (roles.includes(String(roleName)) && baseRole[String(roleName)] !== permission) return [];
  const role = roles.includes(String(roleName)) ? String(roleName) : String(permission);
  const rank = roles.indexOf(role);
  if (rank < 0) return [];
  return [...roles.slice(0, rank + 1).map(name => `repository:${name}`), ...(rank >= 2 ? ['invocation:rerun'] : [])];
}
export function login(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(value)) throw new GitHubError('ACTOR');
  return value;
}
export function issueInput(issue: Record<string, unknown>, repositoryId: number): string {
  if (typeof issue.title !== 'string' || (typeof issue.body !== 'string' && issue.body !== null) ||
    issue.title.length > 1024 || (issue.body?.length ?? 0) > 65536 || issue.pull_request !== undefined) throw new GitHubError('ISSUE_INPUT');
  return digest(canonicalJson({ repositoryId, id: positiveId(issue.id), number: positiveId(issue.number),
    authorId: positiveId(record(issue.user).id), title: issue.title, body: issue.body ?? '' }));
}
