import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getRecord, GitHubError, record, uploadGitHubSecret, type GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import type { HubConnection } from './hub-connection.js';
import { createHubWorkflow, createIssueForm, HUB_FORM_CONFIG_PATH, HUB_FORM_PATH, HUB_MODEL_KEY_SECRET, validateHubManifest, type HubManifest } from './hub-files.js';
import { compileHubPolicy, DEFAULT_HUB_RUN_LIMIT, hubImageSettings, hubLaunchSettings, hubPolicy } from './hub-policy.js';
import { checkModelKey } from './model-key.js';
import type { Progress } from './progress.js';
import type { RuntimeSource } from './workflow-yaml.js';
import { hubLayout, PRODUCT_NAME, type HubLayout } from './identity.js';

const execute = promisify(execFile);
const gitBlob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');

/** Commits changed files in one commit; unchanged files cost nothing, and an unchanged hub makes no commit at all. */
export async function commitHubFiles(api: GitHubApi, repository: string, branch: string, files: Record<string, string>, message: string,
  createOnly: (path: string) => boolean = () => false): Promise<boolean> {
  const ref = await getRecord(api, `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  const head = String(record(ref.object).sha);
  const commit = await getRecord(api, `/repos/${repository}/git/commits/${head}`);
  const baseTree = String(record(commit.tree).sha);
  const tree = await getRecord(api, `/repos/${repository}/git/trees/${baseTree}?recursive=1`);
  if (tree.truncated === true || !Array.isArray(tree.tree)) throw new GitHubError('HUB_TREE');
  const existing = new Map(tree.tree.map(entry => [String(record(entry).path), String(record(entry).sha)]));
  // Files the user is told to edit, such as destination policies, are written once and never replaced.
  const changes = Object.entries(files).filter(([path, content]) => existing.get(path) !== gitBlob(content) && !(createOnly(path) && existing.has(path)));
  if (!changes.length) return false;
  const created = await api.request('POST', `/repos/${repository}/git/trees`, { base_tree: baseTree,
    tree: changes.map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
  if (created.status !== 201) throw new GitHubError('HUB_TREE_CREATE', created.status);
  const next = await api.request('POST', `/repos/${repository}/git/commits`, { message, tree: record(created.body).sha, parents: [head] });
  if (next.status !== 201) throw new GitHubError('HUB_COMMIT', next.status);
  const moved = await api.request('PATCH', `/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: record(next.body).sha, force: false });
  if (moved.status !== 200) throw new GitHubError('HUB_REF_UPDATE', moved.status);
  return true;
}

export interface ModelKeyDependencies {
  progress: Progress;
  confirm?(question: string): Promise<boolean>;
  /** Interactive hidden prompt that already checked and confirmed the key. */
  askKey?(): Promise<string>;
  environmentKey?: string;
}
/** The model key lives only in the hub. An existing key is kept unless the user chooses to replace it. */
export async function ensureModelKey(api: GitHubApi, hub: string, dependencies: ModelKeyDependencies): Promise<void> {
  const existing = await api.request('GET', `/repos/${hub}/actions/secrets/${HUB_MODEL_KEY_SECRET}`);
  if (existing.status === 200) {
    const changed = new Date(String(record(existing.body).updated_at)).toLocaleString();
    if (!dependencies.confirm || !await dependencies.confirm(`An OpenAI API key is already stored in ${hub} (last changed ${changed}). Replace it?`)) {
      dependencies.progress.line('✓ Keeping the stored OpenAI API key');
      return;
    }
  } else if (existing.status !== 404) throw new GitHubError('SECRET_PREFLIGHT', existing.status);
  const key = dependencies.askKey ? await dependencies.askKey() : checkModelKey(dependencies.environmentKey ?? '').value;
  const task = dependencies.progress.task(`Saving the OpenAI API key in ${hub}`);
  await uploadGitHubSecret(api, { kind: 'repository', repository: hub }, HUB_MODEL_KEY_SECRET, key, { replace: true });
  task.done(`Saved the OpenAI API key in ${hub} (the only place it is stored)`);
}

/** A private runtime source is read by the hub alone, through a read-only deploy key created for it, in the layout's secret. */
export async function ensureRuntimeReadKey(api: GitHubApi, runtimeRepository: string, hub: string, layout: HubLayout, progress: Progress): Promise<void> {
  const existing = await api.request('GET', `/repos/${hub}/actions/secrets/${layout.runtimeKeySecret}`);
  if (existing.status === 200) return;
  if (existing.status !== 404) throw new GitHubError('SECRET_PREFLIGHT', existing.status);
  const task = progress.task(`Giving ${hub} read-only access to ${runtimeRepository}`);
  const directory = mkdtempSync(join(tmpdir(), 'software-factory-key-'));
  try {
    const path = join(directory, 'key');
    await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `software-factory ${hub}`, '-f', path], { timeout: 20000 });
    const added = await api.request('POST', `/repos/${runtimeRepository}/keys`, { title: `${PRODUCT_NAME} hub ${hub}`, key: readFileSync(`${path}.pub`, 'utf8').trim(), read_only: true });
    if (added.status !== 201) throw Error(`Could not add a read-only deploy key to ${runtimeRepository} (HTTP ${added.status}). You need admin access to it.`);
    try { await uploadGitHubSecret(api, { kind: 'repository', repository: hub }, layout.runtimeKeySecret, readFileSync(path, 'utf8'), { replace: true }); }
    catch (error) {
      // A deploy key whose private half was never stored is useless; remove it so reruns do not accumulate them.
      await api.request('DELETE', `/repos/${runtimeRepository}/keys/${record(added.body).id}`).catch(() => undefined);
      throw error;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  task.done(`${hub} can read ${runtimeRepository} (read-only deploy key)`);
}

/** Issues are how agents are requested, so the hub must accept them (hubs made by an earlier build did not). */
export async function ensureIssuesEnabled(api: GitHubApi, hub: string): Promise<void> {
  const repo = await getRecord(api, `/repos/${hub}`);
  if (repo.has_issues === true) return;
  const updated = await api.request('PATCH', `/repos/${hub}`, { has_issues: true });
  if (updated.status !== 200) throw new GitHubError('HUB_ISSUES', updated.status);
}

export interface HubPlan { layout: HubLayout; manifest: HubManifest; files: Record<string, string> }
/**
 * Everything the hub commits: its manifest, the organization's policy, the issue form and its workflow, all in the
 * hub's own layout, so a hub made under the earlier name keeps its one workflow, its folder and its secrets.
 */
export function planHub(connection: HubConnection, runtime: Record<string, unknown>, source: RuntimeSource, options: { registryLogin: boolean; policy?: string }): HubPlan {
  if (connection.phase !== 'connected') throw Error('Connect GitHub first');
  const layout = hubLayout(connection.layout);
  const manifest = validateHubManifest({ schemaVersion: 2, kind: layout.manifestKind, organization: connection.organization, hub: connection.hub,
    app: { id: connection.app!.id, installationId: connection.app!.installationId } }, layout);
  const policy = options.policy ?? hubPolicy(runtime);
  // Compiling for a sample target proves the policy is valid before anything is written.
  const config = compileHubPolicy(policy, manifest, `${connection.organization}/example`).configuration;
  const { signerRepository } = hubImageSettings(JSON.parse(policy));
  return { layout, manifest, files: {
    [layout.manifestPath]: JSON.stringify(manifest, null, 2) + '\n',
    [layout.policyPath]: policy,
    [HUB_FORM_PATH]: createIssueForm(connection.organization),
    [HUB_FORM_CONFIG_PATH]: 'blank_issues_enabled: false\n',
    [layout.workflowPath]: createHubWorkflow({ layout, source, image: config.environment.image, registryLogin: options.registryLogin,
      timeoutMinutes: config.limits.timeoutMinutes, maxRunNumber: DEFAULT_HUB_RUN_LIMIT, retentionDays: hubLaunchSettings(policy).evidence.retentionDays,
      ...(signerRepository ? { signerRepository } : {}) }),
  } };
}
