import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkSetup, type CheckContext, type GitHubTransport, type Setup } from '@intelligent-iterations/ii-agent-runtime';

export interface WorkflowBinding { id: number; ref: string; commit: string }
export async function checkWorkflowBinding(repository: string, transport: GitHubTransport, workflow: WorkflowBinding, label: string) {
  if (!workflow || !Number.isSafeInteger(workflow.id) || workflow.id < 1 || typeof workflow.ref !== 'string' || !workflow.ref.trim() || !/^[a-f0-9]{40}$/.test(workflow.commit)) throw Error(`${label}: invalid workflow binding`);
  const status = await transport.request('GET', `/repos/${repository}/actions/workflows/${workflow.id}`);
  if (status.status !== 200 || (status.body as { state?: string })?.state !== 'active') throw Error(`${label}: workflow is unavailable or disabled`);
  const revision = await transport.request('GET', `/repos/${repository}/commits/${encodeURIComponent(workflow.ref)}`);
  if (revision.status !== 200 || (revision.body as { sha?: string })?.sha !== workflow.commit) throw Error(`${label}: workflow ref no longer matches its approved commit`);
  return { workflowId: workflow.id, ref: workflow.ref, commit: workflow.commit };
}

/** Read-only readiness checks for the shipped coding installation; launch revalidates its own inputs. */
export async function checkCodeInstallation(options: {
  repository: string; transport: GitHubTransport; checks: CheckContext;
  verificationSetup: Setup; verificationWorkflow: WorkflowBinding;
  source: { repository: string; commit: string; bundle: string; sha256: string };
}) {
  const { source } = options;
  if (!source || !/^[\w.-]+\/[\w.-]+$/.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Invalid trusted source baseline');
  if (options.verificationSetup.secrets.length) throw Error('Verification setup must be credential-free');
  const verification = await checkSetup(options.verificationSetup, options.checks);
  if (!verification.allowed) throw Error('Verification setup authorization failed');
  const workflow = await checkWorkflowBinding(options.repository, options.transport, options.verificationWorkflow, 'Verification');
  const bundle = resolve(source.bundle);
  if (!(await lstat(bundle)).isFile()) throw Error('Trusted base bundle must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(bundle)) hash.update(chunk);
  if (hash.digest('hex') !== source.sha256) throw Error('Trusted base bundle digest mismatch');
  const directory = await mkdtemp(join(tmpdir(), 'factory-base-check-'));
  try {
    const git = (args: string[]) => promisify(execFile)('/usr/bin/git', args, { cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
    await git(['init', '--bare', '--quiet']);
    try { await git(['bundle', 'verify', bundle]); }
    catch { throw Error('Trusted base bundle is invalid or requires missing objects'); }
    const heads = (await git(['bundle', 'list-heads', bundle])).stdout.trim().split('\n');
    if (!heads.some(line => line.split(' ')[0] === source.commit)) throw Error('Trusted base bundle does not advertise the configured commit');
  } finally { await rm(directory, { recursive: true, force: true }); }
  return { verification, workflow, source: { repository: source.repository, commit: source.commit, sha256: source.sha256 },
    limitation: 'Verifies local bundle integrity and metadata, not source provenance or acceptance-check quality.' };
}
