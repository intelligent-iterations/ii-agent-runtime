import { getRecord, GitHubError, positiveId, record, type GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';

/** Turns a GitHub permission failure into the instruction that fixes it. */
export async function explain<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof GitHubError && [401, 403, 404].includes(error.status ?? 0)) throw Error(message);
    throw error;
  }
}
const freePlan = (org: Record<string, unknown>) => ['free', ''].includes(String(record(org.plan ?? {}).name ?? '').toLowerCase());

export async function preflight(api: GitHubApi, organization: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(organization)) throw Error('Invalid organization');
  const member = await explain(() => getRecord(api, `/user/memberships/orgs/${organization}`),
    `Could not read your membership in ${organization}. Run: gh auth refresh -h github.com -s read:org`);
  if (member.state !== 'active' || !['admin', 'member'].includes(String(member.role))) throw Error(`You need active membership in ${organization}.`);
  // Resuming an interrupted run uses the owner-only installation inventory; check it before any App exists.
  if (member.role === 'admin') {
    const inventory = await explain(() => getRecord(api, `/orgs/${organization}/installations?per_page=1`),
      `Listing ${organization}'s App installations needs the admin:org scope. Run: gh auth refresh -h github.com -s admin:org`);
    if (!Array.isArray(inventory.installations)) throw new GitHubError('INSTALLATION_INVENTORY');
  }
  const org = await getRecord(api, `/orgs/${organization}`);
  return { owner: member.role === 'admin', free: freePlan(org), id: positiveId(org.id) };
}
