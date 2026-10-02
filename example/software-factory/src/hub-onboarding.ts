import { appJwt, getRecord, GitHubError, positiveId, record, uploadGitHubSecret, type GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import type { BrowserSession } from './onboarding-browser.js';
import type { FactoryConnection } from './connection-store.js';
import { reached, type HubConnection, type HubRecords } from './hub-connection.js';
import { explain, preflight } from './onboarding-checks.js';
import type { Progress } from './progress.js';
import { CURRENT_LAYOUT, HUB_LAYOUTS, hubLayout, PRODUCT_NAME, type HubLayout } from './identity.js';

export interface HubOnboardingDependencies {
  api: GitHubApi;
  records: HubRecords;
  /** The per-repository connection written by earlier versions, which the hub replaces. */
  legacy?: { load(): FactoryConnection | undefined; reset(): void };
  browser(organization: string): Promise<BrowserSession>;
  open(url: string): Promise<void>;
  waitForAppPage?(slug: string): Promise<void>;
  pause?(message: string): Promise<void>;
  confirm?(question: string): Promise<boolean>;
  progress: Progress;
}
export interface HubOnboardingInput { organization: string; hubName: string }

const settings = (organization: string) => `https://github.com/organizations/${organization}/settings/apps`;

/** GitHub shows an App's key once and has no API to delete an App, so an App whose key is gone is deleted by the user. */
async function removeApp(organization: string, slug: string, why: string, dependencies: HubOnboardingDependencies): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const app = await dependencies.api.request('GET', `/apps/${slug}`);
    if (app.status === 404) break;
    if (app.status !== 200) throw new GitHubError('APP_LOOKUP', app.status);
    if (!dependencies.pause || attempt > 3) throw Error(`${why} Delete it at ${settings(organization)}/${slug}/advanced (Delete GitHub App), then rerun software-factory init.`);
    if (attempt === 1) {
      dependencies.progress.line(`${why} GitHub only shows an App's key once, so ${slug} has to be deleted before a new App is created.`);
      dependencies.progress.line('Opening its settings: choose Delete GitHub App at the bottom of the page.');
      await dependencies.open(`${settings(organization)}/${slug}/advanced`);
    } else dependencies.progress.line(`${slug} still exists in GitHub.`);
    await dependencies.pause('After deleting the App in GitHub, press Enter to continue: ');
  }
  dependencies.progress.line(`✓ ${slug} deleted`);
}

/**
 * The earlier design stored its App key in each destination; that secret is the Factory's own and is deleted.
 * OPENAI_API_KEY may be the user's own secret, so it is only reported.
 */
async function removeLegacySecrets(api: GitHubApi, legacy: FactoryConnection, progress: Progress): Promise<void> {
  const roots = legacy.secretScope === 'organization' ? [`/orgs/${legacy.organization}`] : legacy.repositories.map(repo => `/repos/${repo.name}`);
  const task = progress.task('Removing the earlier design\'s App key secrets', roots.length);
  const remaining: string[] = [];
  for (const root of roots) {
    if (legacy.privateKeySecret) {
      const removed = await api.request('DELETE', `${root}/actions/secrets/${legacy.privateKeySecret}`);
      if (![204, 404].includes(removed.status)) throw new GitHubError('LEGACY_SECRET_DELETE', removed.status);
    }
    if ((await api.request('GET', `${root}/actions/secrets/OPENAI_API_KEY`)).status === 200) remaining.push(root.replace(/^\/(repos|orgs)\//, ''));
    task.tick(root.replace(/^\/(repos|orgs)\//, ''));
  }
  task.done(`Removed the earlier App key secret from ${roots.length} ${legacy.secretScope === 'organization' ? 'organization' : 'repositories'}`);
  if (remaining.length) progress.line(`! OPENAI_API_KEY is still stored in ${remaining.join(', ')}. ${PRODUCT_NAME} now keeps it in the hub only; delete those copies unless something else uses them.`);
}

/**
 * Anyone who can push to the hub can run a workflow that reads its secrets, so only admins may write to it and it may
 * hold no workflow but its own. Checked on every onboarding run; reading these settings needs an owner's token, which
 * the hub's own launches do not have.
 */
export async function verifyHubAccess(api: GitHubApi, organization: string, hub: string, layout: HubLayout): Promise<void> {
  const org = await getRecord(api, `/orgs/${organization}`);
  if (!['none', 'read'].includes(String(org.default_repository_permission))) throw Error(`Every member of ${organization} can write to new repositories (base permission "${org.default_repository_permission}"), so any member could read the hub's keys. Set the base permission to Read or No permission at https://github.com/organizations/${organization}/settings/member_privileges, then rerun.`);
  const writers: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await api.request('GET', `/repos/${hub}/collaborators?affiliation=all&per_page=100&page=${page}`);
    if (response.status !== 200 || !Array.isArray(response.body)) throw Error(`Could not list who can access ${hub} (HTTP ${response.status}).`);
    for (const entry of response.body.map(record)) {
      const permissions = record(entry.permissions ?? {});
      if ((permissions.push === true || permissions.maintain === true) && permissions.admin !== true) writers.push(String(entry.login));
    }
    if (response.body.length < 100) break;
  }
  const teams = await api.request('GET', `/repos/${hub}/teams?per_page=100`);
  if (teams.status !== 200 || !Array.isArray(teams.body)) throw Error(`Could not list the teams with access to ${hub} (HTTP ${teams.status}).`);
  for (const team of teams.body.map(record)) if (!['pull', 'triage', 'admin'].includes(String(team.permission))) writers.push(`team ${String(team.slug)}`);
  if (writers.length) throw Error(`${hub} holds the keys, so only admins may write to it. Remove write access for ${writers.join(', ')} at https://github.com/${hub}/settings/access, then rerun.`);
  const workflows = await api.request('GET', `/repos/${hub}/contents/.github/workflows`);
  if (workflows.status === 200 && Array.isArray(workflows.body) && workflows.body.some(entry => `.github/workflows/${record(entry).name}` !== layout.workflowPath)) {
    throw Error(`${hub} has workflows other than ${PRODUCT_NAME}'s, and any of them could read its keys. Remove them, or rerun with --hub-repository to use a new hub.`);
  }
  if (workflows.status !== 200 && workflows.status !== 404) throw new GitHubError('HUB_WORKFLOWS', workflows.status);
}

/**
 * Creates the hub, or adopts an earlier one in the layout its manifest is in: a hub made under the earlier name keeps
 * every durable name (see identity.ts), so it is never given a second workflow or a second set of secrets.
 */
async function ensureHub(api: GitHubApi, organization: string, name: string, progress: Progress) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name)) throw Error('Invalid hub repository name');
  const task = progress.task(`Preparing the hub repository ${organization}/${name}`);
  let response = await api.request('GET', `/repos/${organization}/${name}`);
  let created = false;
  if (response.status === 404) {
    response = await api.request('POST', `/orgs/${organization}/repos`, { name, private: true, auto_init: true, has_issues: true, has_projects: false,
      has_wiki: false, description: `${PRODUCT_NAME}: file an Agent task issue here to have an agent change one of this organization's repositories.` });
    if (response.status !== 201) throw Error(`Could not create ${organization}/${name} (HTTP ${response.status}). Your GitHub CLI login needs the repo scope and permission to create repositories: gh auth refresh -h github.com -s repo,admin:org`);
    created = true;
  } else if (response.status !== 200) throw new GitHubError('HUB_LOOKUP', response.status);
  const repo = record(response.body);
  const repository = String(repo.full_name).toLowerCase();
  if (repo.private !== true || repo.archived !== false || record(repo.permissions ?? {}).admin !== true || typeof repo.default_branch !== 'string' ||
    repository !== `${organization}/${name}`.toLowerCase()) throw Error(`${organization}/${name} must be a private, active repository you administer. Rerun with --hub-repository to use another name.`);
  const branch = repo.default_branch;
  for (let attempt = 0; ; attempt++) {
    const ref = await api.request('GET', `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 200) break;
    if (attempt >= 15) throw Error(`${repository} has no commits yet. Add a README in GitHub, then rerun.`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const recordedApps: number[] = [];
  let layout: HubLayout | undefined;
  for (const candidate of created ? [] : HUB_LAYOUTS) {
    const marker = await api.request('GET', `/repos/${repository}/contents/${candidate.manifestPath}?ref=${encodeURIComponent(branch)}`);
    if (marker.status === 404) continue;
    if (marker.status !== 200) throw new GitHubError('HUB_MARKER', marker.status);
    const manifest = JSON.parse(Buffer.from(String(record(marker.body).content ?? ''), 'base64').toString('utf8'));
    if (String(manifest.organization) !== organization) throw Error(`${repository} is the hub of another organization.`);
    if (manifest.kind !== undefined && manifest.kind !== candidate.manifestKind) throw Error(`${repository}/${candidate.manifestPath} is not a ${PRODUCT_NAME} hub manifest.`);
    for (const app of [manifest.app, manifest.trigger]) if (Number.isSafeInteger(app?.id)) recordedApps.push(app.id);
    layout = candidate;
    break;
  }
  if (!created && !layout) {
    const root = await getRecord(api, `/repos/${repository}/git/trees/${encodeURIComponent(branch)}`).catch(() => ({ tree: [] }));
    const names = Array.isArray(root.tree) ? root.tree.map(entry => String(record(entry).path)) : [];
    if (names.some(entry => !['README.md', '.gitignore', 'LICENSE'].includes(entry))) throw Error(`${repository} already exists and is not a ${PRODUCT_NAME} hub. Rerun with --hub-repository <name> to create a different one.`);
  }
  task.done(`${created ? 'Created' : 'Using'} the private hub repository ${repository}`);
  return { hub: { repository, id: positiveId(repo.id), branch }, recordedApps, layout: layout ?? CURRENT_LAYOUT };
}

async function createApp(organization: string, dependencies: HubOnboardingDependencies) {
  const session = await dependencies.browser(organization);
  try {
    dependencies.progress.line(`\nOpening GitHub to create the ${PRODUCT_NAME} App (the identity agents use). Choose Create GitHub App.`);
    await dependencies.open(session.startUrl);
    const code = await session.code;
    const converted = await dependencies.api.request('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`);
    if (converted.status !== 201) throw new GitHubError('APP_CREATION_UNCONFIRMED', converted.status);
    const app = record(converted.body);
    const owner = record(app.owner);
    if (owner.type !== 'Organization' || String(owner.login).toLowerCase() !== organization ||
      typeof app.pem !== 'string' || typeof app.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(app.slug)) throw new GitHubError('APP_CREATION_RESPONSE');
    const id = positiveId(app.id);
    appJwt(id, app.pem); // Validate signing material before anything depends on it.
    return { id, slug: app.slug, pem: app.pem, session };
  } catch (error) { await session.close(); throw error; }
}

/** The owner-visible installation inventory confirms the installation without the App key, which stays in the hub. */
async function findInstallation(api: GitHubApi, organization: string, appId: number) {
  for (let page = 1; page <= 10; page++) {
    const response = await getRecord(api, `/orgs/${organization}/installations?per_page=100&page=${page}`);
    if (!Array.isArray(response.installations)) throw new GitHubError('INSTALLATION_INVENTORY');
    const found = response.installations.map(record).find(entry => entry.app_id === appId);
    if (found) return found;
    if (response.installations.length < 100) break;
  }
  return undefined;
}

/** Creates or resumes the hub and its App. The hub's files are written afterwards by setupHub. */
export async function connectHub(input: HubOnboardingInput, dependencies: HubOnboardingDependencies): Promise<HubConnection> {
  const organization = input.organization.toLowerCase();
  const { records, progress } = dependencies;
  let connection = records.load();
  if (connection && connection.organization !== organization) throw Error('Existing connection belongs to a different organization; use a separate connection directory');
  if (!connection) {
    const legacy = dependencies.legacy?.load();
    if (legacy?.appSlug) {
      await removeApp(organization, legacy.appSlug,
        `${organization} was set up with the earlier design, which stored the App key in every repository. That App's key cannot be moved to the hub.`, dependencies);
      await removeLegacySecrets(dependencies.api, legacy, progress);
    }
    if (legacy) dependencies.legacy!.reset();
  }
  // A new hub gets the current layout; an existing hub found below keeps its own.
  connection ??= { schemaVersion: 2, organization, phase: 'started', layout: CURRENT_LAYOUT.name };
  // The key lives only in memory between creation and storage in the hub; an App interrupted in that window is unusable.
  if (connection.phase === 'app-creation-started' || connection.phase === 'app-created') {
    if (connection.app) await removeApp(organization, connection.app.slug, `A previous run stopped after creating ${connection.app.slug}, before its key was saved.`, dependencies);
    else if (!dependencies.confirm || !await dependencies.confirm(`A previous run was interrupted while creating the App. If ${settings(organization)} lists an unfinished ${PRODUCT_NAME} App, delete it first. Continue?`)) throw Error(`Onboarding was interrupted during App creation; delete any unfinished ${PRODUCT_NAME} App, then rerun.`);
    connection = { ...connection, phase: 'hub-ready' };
    delete connection.app;
  }
  const account = await preflight(dependencies.api, organization);
  if (!account.owner) throw Error(`Creating the hub repository and its GitHub App needs an owner of ${organization}.`);
  if (!reached(connection, 'hub-ready')) {
    const { hub, recordedApps, layout } = await ensureHub(dependencies.api, organization, input.hubName, progress);
    const live = recordedApps.length ? (await findInstallationsOf(dependencies.api, organization, recordedApps)) : [];
    if (live.length) throw Error(`${hub.repository} was set up from another machine, or by a run whose local state is gone, and its Apps are still installed (${live.join(', ')}). Rerun example/software-factory/onboard.sh on that machine, or delete those Apps at ${settings(organization)} and rerun here.`);
    connection = { ...connection, hub, layout: layout.name, phase: 'hub-ready' };
    records.save(connection);
  }
  const hub = connection.hub!;
  const layout = hubLayout(connection.layout);
  await verifyHubAccess(dependencies.api, organization, hub.repository, layout);
  for (const name of records.removeLocalKeys()) progress.line(`✓ Removed ${name}, a key file an earlier build kept on this machine`);
  let session: BrowserSession | undefined;
  try {
    if (!reached(connection, 'app-created')) {
      connection = { ...connection, phase: 'app-creation-started' }; records.save(connection);
      const created = await createApp(organization, dependencies);
      session = created.session;
      connection = { ...connection, app: { id: created.id, slug: created.slug }, phase: 'app-created' }; records.save(connection);
      const task = progress.task(`Saving the App key in ${hub.repository}`);
      await explain(() => uploadGitHubSecret(dependencies.api, { kind: 'repository', repository: hub.repository }, layout.appKeySecret, created.pem, { replace: true }),
        `Could not store Actions secrets in ${hub.repository}. Your GitHub CLI login needs the repo scope.`);
      connection = { ...connection, phase: 'app-stored' }; records.save(connection);
      task.done(`Created the App ${created.slug}; its key is stored only in ${hub.repository}`);
    }
    const app = connection.app!;
    let installation = await findInstallation(dependencies.api, organization, app.id);
    if (!installation) {
      progress.line('\nInstall the App on the repositories agents may change. "All repositories" is simplest; you can narrow it later in GitHub.');
      await dependencies.waitForAppPage?.(app.slug);
      await dependencies.open(`https://github.com/apps/${app.slug}/installations/new`);
      if (session) await session.installation;
      else if (dependencies.pause) await dependencies.pause('After installing the App in GitHub, press Enter to continue: ');
      else throw Error('Rerun interactively to install the App');
      installation = await findInstallation(dependencies.api, organization, app.id);
      if (!installation) throw Error(`${app.slug} is not installed yet. Install it at https://github.com/apps/${app.slug}/installations/new, then rerun.`);
    }
    const permissions = record(installation.permissions ?? {});
    if (installation.suspended_at !== null || String(record(installation.account).login).toLowerCase() !== organization ||
      permissions.contents !== 'write' || permissions.issues !== 'write') throw Error(`${app.slug} is suspended or lacks contents and issues write access; restore it in the organization's installed Apps, then rerun.`);
    const scope = installation.repository_selection === 'all' ? 'all repositories' : 'the repositories you selected';
    // Apps created before pull requests were added push branches but cannot open pull requests until an owner adds it.
    if (permissions.pull_requests !== 'write') progress.line(`! ${app.slug} cannot open pull requests yet. Add "Pull requests: Read and write" at ${settings(organization)}/${app.slug}/permissions, then accept the change at https://github.com/organizations/${organization}/settings/installations/${installation.id}. Until then each run links a ready-to-open pull request.`);
    connection = { ...connection, app: { ...app, installationId: positiveId(installation.id) }, phase: 'connected' }; records.save(connection);
    progress.line(`✓ ${app.slug} is installed on ${scope}`);
    if (connection.legacyTrigger) progress.line(`! ${connection.legacyTrigger.slug}, a trigger App from an earlier build, is no longer used. Delete it at ${settings(organization)}/${connection.legacyTrigger.slug}/advanced.`);
    return connection;
  } finally { await session?.close(); }
}

async function findInstallationsOf(api: GitHubApi, organization: string, appIds: number[]): Promise<string[]> {
  const response = await getRecord(api, `/orgs/${organization}/installations?per_page=100`);
  return (Array.isArray(response.installations) ? response.installations.map(record) : [])
    .filter(entry => appIds.includes(Number(entry.app_id))).map(entry => String(entry.app_slug));
}
