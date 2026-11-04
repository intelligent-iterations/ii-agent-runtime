import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitToolSession, createToolSession, preflightTools, toolCredentialReferences, type PreflightCheck, type PreflightReport,
  type ToolDefinition, type ToolGrant } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { gcpPermissionPreflight, gcpWorkflowServiceAccountAssessor, githubEvidenceCollector, githubPermissionPreflight,
  type GitHubEvidenceCollector, type WorkflowIdentityAssessor, type WorkflowIdentityAssessors } from '@intelligent-iterations/ii-agent-runtime/tools';

/** A setup or configuration mistake, explained in plain words. The CLI exits 64. */
export class ConfigurationError extends Error {}

/** Trusted TypeScript configuration: the agent's tools and grants, built with defineTool/createGrant. */
export interface AgentGrants {
  subject: string;
  tools: readonly ToolDefinition[];
  grants: readonly ToolGrant[];
}
/** Workflow files the runtime received for one repository branch. */
export interface InspectedWorkflows {
  repository: string;
  branch: string;
  /** A file: URL for a local directory, or the GitHub API commit URL the files were read at. */
  source: string;
  workflows: string[];
}
export interface BoundaryResult {
  subject: string;
  /** repository@branch:path for every repository file the agent may write. */
  writable: string[];
  /** Workflow evidence that was read. Empty when it could not be read. */
  inspected: InspectedWorkflows[];
  report: PreflightReport;
  execution: PreflightCheck;
  answer: 'yes' | 'no' | 'unknown';
  admission: 'admitted' | 'blocked';
}

const runtimePackage = '@intelligent-iterations/ii-agent-runtime';
const pathRule = 'Grant paths are exact file paths, up to 256 per grant: no globs (*) and no directories.';
const outsideFolder = (file: string) => `Grants files must be inside this checker folder (for example agents/${basename(file)}) ` +
  `so they use the checker's runtime. Move ${file} there.`;
/** Plain explanations for the mistakes newcomers make in grants files. */
function loadError(file: string, error: unknown): ConfigurationError {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if ((code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') && message.includes(runtimePackage)) return new ConfigurationError(outsideFolder(file));
  if (code === 'TOOL_INVALID_CONSTRAINT') {
    // The runtime names no value; quoted strings containing * are the usual cause.
    const globs = [...new Set([...readFileSync(file, 'utf8').matchAll(/['"`]([^'"`\n]*\*[^'"`\n]*)['"`]/g)].map(match => `'${match[1]}'`))];
    return new ConfigurationError(`${file}: createGrant rejected ${globs.length ? globs.join(', ') : 'a resource list'} (TOOL_INVALID_CONSTRAINT). ` +
      `${pathRule} Repository, branch and path each need at least one exact value.`);
  }
  if (code === 'TOOL_MISSING_RESOURCE_CONSTRAINT') return new ConfigurationError(`${file}: every grant must list repository, branch and path (TOOL_MISSING_RESOURCE_CONSTRAINT).`);
  if (typeof code === 'string' && /^TOOL_[A-Z_]+$/.test(code)) return new ConfigurationError(`${file}: the runtime rejected the tools or grants (${code}). Compare it with agents/broad.ts.`);
  return new ConfigurationError(`${file} failed to load: ${message}`);
}

/** Load a trusted grants module. It runs as your code, like any configuration file. */
export async function loadAgent(file: string): Promise<AgentGrants> {
  const path = resolve(file);
  if (!existsSync(path)) throw new ConfigurationError(`Grants file ${file} not found.`);
  let module: { default?: AgentGrants; agent?: AgentGrants };
  try { module = await import(pathToFileURL(path).href); } catch (error) { throw loadError(file, error); }
  const agent = module.default ?? module.agent;
  if (!agent || typeof agent.subject !== 'string' || !Array.isArray(agent.tools) || !Array.isArray(agent.grants))
    throw new ConfigurationError(`${file} must export { subject, tools, grants } as its default export`);
  // Tools built by another installed copy of the runtime are not registered with this one.
  try { toolCredentialReferences(agent.tools); } catch { throw new ConfigurationError(outsideFolder(file)); }
  const directory = writablePaths(agent).map(entry => entry.slice(entry.indexOf(':') + 1)).find(path => path.endsWith('/'));
  if (directory) throw new ConfigurationError(`${file}: grant path '${directory}' is a directory. ${pathRule}`);
  return agent;
}

const writeTools = (agent: AgentGrants) => agent.tools.filter(tool => tool.provider === 'github' && tool.operation === 'contents.write').map(tool => tool.name);
export function writablePaths(agent: AgentGrants): string[] {
  const tools = writeTools(agent);
  return agent.grants.filter(grant => grant.subject === agent.subject && tools.includes(grant.tool)).flatMap(grant =>
    (grant.resources.repository ?? []).flatMap(repository => (grant.resources.branch ?? []).flatMap(branch =>
      (grant.resources.path ?? []).map(path => `${repository}@${branch}:${path}`))));
}
/** The single repository and branch the grants write to, required for a local workflow directory. */
export function singleScope(agent: AgentGrants): { repository: string; branch: string } {
  const scopes = new Set(writablePaths(agent).map(entry => entry.slice(0, entry.indexOf(':'))));
  if (scopes.size !== 1) throw new ConfigurationError('A local workflow directory describes one repository branch; the grants must write to exactly one');
  const [repository, branch] = [...scopes][0]!.split('@') as [string, string];
  return { repository, branch };
}

const workflowFile = /^[a-zA-Z0-9._-]+\.ya?ml$/;
/** Workflow files from a local checkout. Actions settings are not visible locally, so Actions is treated as enabled. */
export function localWorkflows(directory: string, scope: { repository: string; branch: string }): GitHubEvidenceCollector {
  let root: string;
  try { root = realpathSync(directory); } catch { throw new ConfigurationError(`--workflows ${directory} does not exist.`); }
  if (!statSync(root).isDirectory()) throw new ConfigurationError(`--workflows ${directory} is not a directory.`);
  const names = () => readdirSync(root).filter(name => workflowFile.test(name)).sort();
  // An empty directory would make every grant look clear. Usually the repository root was passed.
  if (!names().length) {
    const nested = join(directory, '.github', 'workflows');
    const hint = existsSync(nested) && statSync(nested).isDirectory() ? ` Did you mean ${nested}?` : '';
    throw new ConfigurationError(`No workflow files (.yml/.yaml) in ${directory}.${hint}`);
  }
  return async (repository, branch) => {
    if (repository !== scope.repository || branch !== scope.branch) throw Error('Local workflows describe another repository branch');
    const files = names();
    if (files.length > 64) throw Error('Too many workflow files');
    return { repository, branch, actionsEnabled: true, complete: true, observedAt: Date.now(), source: pathToFileURL(root).href,
      workflows: files.map(name => ({ path: `.github/workflows/${name}`, content: readFileSync(join(root, name), 'utf8') })) };
  };
}
/**
 * The GitHub repository and checked-out branch of a local checkout, when `directory` is its `.github/workflows`.
 * Reads `.git/config` and `.git/HEAD` as text and runs nothing in the checkout.
 */
export function checkoutOf(directory: string): { repository?: string; branch?: string } {
  try {
    const root = realpathSync(directory);
    if (basename(root) !== 'workflows' || basename(dirname(root)) !== '.github') return {};
    const git = join(dirname(dirname(root)), '.git');
    const url = /\[remote "origin"\][^[]*?^\s*url\s*=\s*(\S+)/m.exec(readFileSync(join(git, 'config'), 'utf8'))?.[1];
    const repository = url ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] : undefined;
    const branch = /^ref: refs\/heads\/(\S+)/.exec(readFileSync(join(git, 'HEAD'), 'utf8'))?.[1];
    return { ...(repository ? { repository } : {}), ...(branch ? { branch } : {}) };
  } catch { return {}; }
}

const githubHints: Record<number, string> = {
  401: ' (GITHUB_TOKEN was rejected)',
  403: ' (forbidden or rate limited)',
  404: ' (not found: check repository and branch in the grants file, and that GITHUB_TOKEN can read the repository)',
};
/**
 * Workflow files and Actions settings through GitHub's read API, pinned to the branch's current commit.
 * Reading Actions settings needs repository admin access. Without it (HTTP 403/404), Actions is treated as
 * enabled, as for local workflow files, and a note is added. That can only keep a finding or "can't tell";
 * the clear rule never depends on Actions being disabled. Other failed reads are noted with their HTTP status.
 */
export function githubWorkflows(token: string, notes: Set<string> = new Set(), request: typeof fetch = fetch): GitHubEvidenceCollector {
  const observed: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    let response: Response;
    try { response = await request(input, init); } catch (error) { notes.add(`GitHub ${path} could not be reached.`); throw error; }
    const repository = /^\/repos\/([^/]+\/[^/]+)\/actions\/permissions$/.exec(path)?.[1];
    if (repository && (response.status === 403 || response.status === 404)) {
      await response.body?.cancel();
      notes.add(`Actions settings for ${repository} need admin access to read, so Actions is treated as enabled.`);
      return Response.json({ enabled: true });
    }
    // A missing .github/workflows directory is not an error; the CLI reports zero workflow files.
    if (!response.ok && !(response.status === 404 && /\/contents\/\.github\/workflows$/.test(path)))
      notes.add(`GitHub ${path} returned HTTP ${response.status}${githubHints[response.status] ?? ''}.`);
    return response;
  };
  return githubEvidenceCollector({ token: async () => token, fetch: observed });
}

/** Fails at startup when the GCP token file is missing or empty. */
export function checkGcpTokenFile(file: string): void {
  let token: string;
  try { token = readFileSync(file, 'utf8').trim(); }
  catch { throw new ConfigurationError(`--gcp-token-file ${file} cannot be read. Create it with: gcloud auth print-access-token > ${file}`); }
  if (!token) throw new ConfigurationError(`--gcp-token-file ${file} is empty. Fill it with: gcloud auth print-access-token > ${file}`);
}

const gcpHints: Record<number, string> = {
  401: ' (token rejected or expired: refresh it with gcloud auth print-access-token)',
  403: ' (permission denied: see the reader roles in the README)',
  404: ' (not found)',
};
function gcpTarget(url: URL): string {
  if (url.hostname === 'iam.googleapis.com') return `read of ${/serviceAccounts\/([^:/]+)/.exec(url.pathname)?.[1] ?? 'a service account'}'s IAM policy`;
  if (url.hostname === 'cloudresourcemanager.googleapis.com') return `read of project ${/projects\/([^:/]+)/.exec(url.pathname)?.[1] ?? '?'}'s IAM policy`;
  return 'Policy Troubleshooter request';
}
/**
 * The service-account adapter, using a GCP OAuth access token read from a file you choose, for example
 * `gcloud auth print-access-token > token`. The file is read for each request and never printed. Failed
 * requests are noted with their HTTP status.
 */
export function gcpServiceAccounts(tokenFile: string, notes: Set<string> = new Set(), request: typeof fetch = fetch): WorkflowIdentityAssessor {
  const observed: typeof fetch = async (input, init) => {
    const target = gcpTarget(new URL(input instanceof Request ? input.url : String(input)));
    let response: Response;
    try { response = await request(input, init); } catch (error) { notes.add(`GCP ${target} did not complete.`); throw error; }
    if (!response.ok) notes.add(`GCP ${target} returned HTTP ${response.status}${gcpHints[response.status] ?? ''}.`);
    return response;
  };
  return gcpWorkflowServiceAccountAssessor({ token: async () => readFileSync(tokenFile, 'utf8').trim(), fetch: observed });
}

/** Runs the runtime's preflight for the agent's grants. Never resolves or uses the agent's own credentials. */
export async function checkBoundary(options: {
  agent: AgentGrants;
  workflows: GitHubEvidenceCollector;
  /** Cloud adapters by provider, for example `{ gcp: gcpServiceAccounts(tokenFile) }`. */
  workflowIdentity?: WorkflowIdentityAssessors;
  signal?: AbortSignal;
}): Promise<BoundaryResult> {
  const { agent } = options;
  if (!writeTools(agent).length) throw new ConfigurationError('The grants define no GitHub contents.write tool to check');
  const inspected: InspectedWorkflows[] = [];
  const workflows: GitHubEvidenceCollector = async (repository, branch, signal) => {
    const evidence = await options.workflows(repository, branch, signal);
    inspected.push({ repository, branch, source: evidence.source, workflows: evidence.workflows.map(workflow => workflow.path) });
    return evidence;
  };
  const signal = options.signal ?? AbortSignal.timeout(120000);
  const session = createToolSession({ subject: agent.subject, tools: agent.tools, grants: agent.grants,
    context: { executionId: 'deployment-boundary-check', attemptId: 'preflight', inputDigest: 'sha256:deployment-boundary-check',
      deadlineMs: Date.now() + 120000, signal },
    resolveCredential: async () => { throw Error('The boundary checker never resolves agent credentials'); } });
  const report = await preflightTools(session, { signal, timeoutMs: 120000, inspectors: [
    githubPermissionPreflight(workflows, options.workflowIdentity ? { workflowIdentity: options.workflowIdentity } : {}),
    gcpPermissionPreflight()] });
  const execution = report.checks.find(check => check.id === 'github.workflow-execution')!;
  let admission: BoundaryResult['admission'] = 'admitted';
  try { admitToolSession(session, report); } catch { admission = 'blocked'; }
  const answer = execution.status === 'finding' ? 'yes' : execution.status === 'unknown' ? 'unknown' : 'no';
  return { subject: agent.subject, writable: writablePaths(agent), inspected, report, execution, answer, admission };
}

/** A repository branch without workflow files would make every grant look clear: refuse to answer instead. */
export function requireWorkflowFiles(result: BoundaryResult, grantsFile: string): void {
  const empty = result.inspected.find(item => !item.workflows.length);
  if (empty) throw new ConfigurationError(`No workflow files (.yml/.yaml) in .github/workflows of ${empty.repository}@${empty.branch} on GitHub, ` +
    `so there is nothing to check. Check repository and branch in ${grantsFile}.`);
}
