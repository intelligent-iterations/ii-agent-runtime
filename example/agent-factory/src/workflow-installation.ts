import type { Setup } from '@intelligent-iterations/ii-agent-runtime';
import { renderWorkerWorkflow, renderVerificationWorkflow } from './workflow.js';
import type { WorkflowBinding } from './installation-preflight.js';

export interface WorkflowInstallationTransport {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** Install the factory-owned workflow pair without replacing unrelated repository files. */
export async function installFactoryWorkflows(options: {
  repository: string; setup: Setup; transport: WorkflowInstallationTransport;
  wait?: () => Promise<void>;
}): Promise<{ workerWorkflow: WorkflowBinding; verificationWorkflow: WorkflowBinding }> {
  const { repository, transport, setup } = options;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error('Invalid workflow repository');
  const prefix = `/repos/${repository}`;
  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, allowMissing = false): Promise<any> {
    const result = await transport.request(method, prefix + path, body);
    if (allowMissing && result.status === 404) return undefined;
    if (result.status < 200 || result.status >= 300) throw Error(`Workflow installation failed (${method} ${path}, HTTP ${result.status}); check repository access and branch rules`);
    return result.body;
  }
  const metadata = await request('GET', '');
  if (!metadata.private || typeof metadata.default_branch !== 'string') throw Error('Factory workflows require an initialized private repository');
  const branch = metadata.default_branch;
  const head = await request('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
  let commit = head?.object?.sha;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid default-branch revision');
  const verifier = { ...setup, id: 'acceptance', harness: { name: 'verification', version: '1' }, secrets: [], capture: { paths: ['verification.json'] } };
  const files = [
    { path: '.github/workflows/factory-codex.yml', content: renderWorkerWorkflow(repository, setup) },
    { path: '.github/workflows/factory-verification.yml', content: renderVerificationWorkflow(repository, verifier) },
  ];
  const changed = [];
  for (const file of files) {
    const previous = await request('GET', `/contents/${file.path}?ref=${commit}`, undefined, true);
    if (previous?.type === 'file' && previous.encoding === 'base64' && Buffer.from(previous.content, 'base64').toString('utf8') === file.content) continue;
    if (previous !== undefined) throw Error(`Existing ${file.path} differs; review its contents before replacing it`);
    changed.push({ path: file.path, mode: '100644', type: 'blob', content: file.content });
  }
  if (changed.length) {
    const base = await request('GET', `/git/commits/${commit}`);
    const tree = await request('POST', '/git/trees', { base_tree: base.tree.sha, tree: changed });
    const created = await request('POST', '/git/commits', { message: 'Install self-hosted coding factory workflows', tree: tree.sha, parents: [commit] });
    if (!/^[a-f0-9]{40}$/.test(created.sha)) throw Error('Invalid installed workflow commit');
    // Non-forced advancement fails if another writer moved the branch incompatibly.
    await request('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: created.sha, force: false });
    commit = created.sha;
  }
  const ref = `factory-workflows-${commit}`;
  const pinned = await request('GET', `/git/ref/tags/${ref}`, undefined, true);
  if (pinned && (pinned.object?.sha !== commit || pinned.object?.type !== 'commit')) throw Error('Workflow pin conflicts with an existing tag');
  if (!pinned) await request('POST', '/git/refs', { ref: `refs/tags/${ref}`, sha: commit });
  const bindings: WorkflowBinding[] = [];
  for (const file of files) {
    let workflow;
    for (let attempt = 0; attempt < 15; attempt++) {
      workflow = await request('GET', `/actions/workflows/${file.path.split('/').at(-1)}`, undefined, true);
      if (workflow) break;
      await (options.wait?.() ?? new Promise(resolve => setTimeout(resolve, 1000)));
    }
    if (!Number.isSafeInteger(workflow?.id) || workflow.id < 1 || workflow.state !== 'active') throw Error('Installed workflow is not yet active; rerun setup');
    bindings.push({ id: workflow.id, ref, commit });
  }
  return { workerWorkflow: bindings[0]!, verificationWorkflow: bindings[1]! };
}
