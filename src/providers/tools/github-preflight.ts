import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import type { PreflightCheck, PreflightEvidence, PreflightInput, PreflightInspector } from '../../runtime/preflight.js';
import type { ToolConstraints } from '../../runtime/tools.js';
import { readProviderJson } from './http.js';
import { stepIdentities, type WorkflowIdentityReference } from './workflow-identities.js';

export interface GitHubRepositoryEvidence {
  repository: string;
  branch: string;
  observedAt: number;
  source: string;
  actionsEnabled: boolean;
  /** Workflow files read at the inspected ref. Their contents are data, never executed. */
  workflows: readonly { path: string; content: string }[];
  complete: boolean;
}
/** Collector runs in the trusted supervisor with read access, independently of the agent's grants. */
export type GitHubEvidenceCollector = (repository: string, branch: string, signal: AbortSignal) => Promise<GitHubRepositoryEvidence>;

/** A cloud identity that a workflow job requests, exactly as written in the workflow. */
export interface WorkflowIdentityRequest {
  provider: string;
  /** Resolved identity reference, such as an IAM role ARN or a service account email. */
  identity: string;
  region?: string;
  /** Identity federation resource the job's OIDC token is exchanged with, when the workflow resolves it. */
  federation?: string;
  repository: string;
  branch: string;
  workflow: string;
  /** True when the job obtains the identity with an OIDC token rather than stored keys. */
  oidc: boolean;
  /** GitHub's default OIDC subject for this job, when it can be determined from the workflow. */
  oidcSubject?: string;
}
export interface WorkflowIdentityAuthority { provider: string; operation: string; resources: ToolConstraints }
/** Trusted provider-adapter result. The GitHub check reports it; it does not evaluate provider policy itself. */
export interface WorkflowIdentityAssessment {
  identity: string;
  /** Whether the identity's trust policy admits this job's OIDC subject. */
  trust: 'admits' | 'excludes' | 'unknown';
  /** Authority confirmed by the provider's own policy evaluation. */
  potentialAuthority: readonly WorkflowIdentityAuthority[];
  /** Exact allow statements read from attached policies but not confirmed by provider evaluation. */
  declaredAuthority: readonly WorkflowIdentityAuthority[];
  evidence: readonly PreflightEvidence[];
  limitations: readonly string[];
}
export type WorkflowIdentityAssessor = (request: WorkflowIdentityRequest, signal: AbortSignal) => Promise<WorkflowIdentityAssessment>;
/** One assessor for every provider, or one per provider name; providers without one are reported as not assessed. */
export type WorkflowIdentityAssessors = WorkflowIdentityAssessor | Readonly<Partial<Record<string, WorkflowIdentityAssessor>>>;

interface WorkflowJobSignal {
  job: string;
  executesCode: boolean;
  privileged: boolean;
  unsupported: boolean;
  /** Repository files run by a recognized step after a plain checkout. */
  executed: string[];
  /** Every string value in the job and workflow-level settings, for literal path references. */
  text: string[];
  identities: WorkflowIdentityReference[];
  /** Literal environment name; null when the environment is an expression. */
  environment?: string | null;
}
const MAX_IDENTITY_ASSESSMENTS = 8;
const MAX_AUTHORITY_LINES = 8;

/** Files that tools run or load implicitly. Writing any of them can never be clear. */
export const implicitlyExecutedFiles: readonly string[] = Object.freeze([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', '.yarnrc', '.yarnrc.yml', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', '.pnpmfile.cjs', 'bun.lock', 'bun.lockb', 'bunfig.toml', '.npmrc', '.nvmrc', '.node-version',
  'setup.py', 'setup.cfg', 'pyproject.toml', 'requirements*.txt', 'constraints*.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock',
  'uv.lock', 'tox.ini', 'noxfile.py', 'conftest.py', '.python-version', 'Makefile', 'makefile', 'GNUmakefile', 'CMakeLists.txt',
  'Dockerfile', 'Dockerfile.*', '*.Dockerfile', 'docker-compose*.yml', 'docker-compose*.yaml', 'compose*.yml', 'compose*.yaml',
  'Justfile', 'justfile', 'Taskfile.yml', 'Rakefile', 'Gemfile', 'Gemfile.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'build.rs', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew',
  '.tool-versions', '.envrc', '.env', '*.config.js', '*.config.cjs', '*.config.mjs', '*.config.ts', '*.config.cts', '*.config.mts',
  '.babelrc*', '.eslintrc*',
]);
/** The only file types a clear result can cover: documentation and static media that tools do not run. */
export const inertFileExtensions: readonly string[] = Object.freeze(['.md', '.markdown', '.rst', '.adoc', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf']);
const implicitPatterns = implicitlyExecutedFiles.map(name =>
  new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
// Recognized steps that run repository manifests from the checkout root.
const command = (name: string) => new RegExp(`(?:^|[\\s;&|(])(?:${name})(?=$|[\\s;&|)])`, 'm');
const nodeInputs = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', '.yarnrc.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'bun.lock', 'bun.lockb', '.npmrc'];

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function referencesSecret(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{\{[^}]*\bsecrets\s*(?:\.|\[)/.test(value);
  if (Array.isArray(value)) return value.some(referencesSecret);
  return record(value) && Object.values(value).some(referencesSecret);
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (record(value)) for (const item of Object.values(value)) strings(item, out);
  return out;
}
const literal = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && !value.includes('${{') ? value.trim() : undefined;

/** A repository-relative program path such as `ci/test` or `./gradlew`; absolute, home, variable and parent paths are not. */
function relativeProgram(word: string | undefined): string | undefined {
  if (!word) return undefined;
  const path = word.startsWith('./') ? word.slice(2) : word;
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return undefined;
  return word.startsWith('./') || path.includes('/') ? path : undefined;
}

function executedInputs(run: string): string[] {
  const files: string[] = [];
  for (const match of run.matchAll(/(?:^|[\s;])(?:\.\/)?([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:sh|py|js|mjs|cjs|ps1))(?=$|[\s;])/g)) files.push(match[1]!);
  // Literal programs at command position, with or without an extension: `ci/test`, `./gradlew`, `bash script/build`.
  for (const segment of run.replace(/\\\r?\n/g, ' ').split(/\r?\n|;|&&|\|\||\|/)) {
    const words = segment.trim().split(/\s+/);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    const program = relativeProgram(/^(?:bash|sh|zsh|python3?|node)$/.test(words[0] ?? '') ? words[1] : words[0]);
    if (program) files.push(program);
  }
  if (command('npm|npx|yarn|pnpm|bun').test(run)) files.push(...nodeInputs);
  if (command('make').test(run)) files.push('Makefile', 'makefile', 'GNUmakefile');
  if (command('docker\\s+(?:buildx\\s+)?build').test(run)) files.push('Dockerfile');
  for (const match of run.matchAll(/(?:^|[\s;&|(])pip3?\s+install\b[^;\n&|]*?(?:-r|--requirement)\s+(?:\.\/)?([a-zA-Z0-9_./-]+)/g)) files.push(match[1]!);
  if (/(?:^|[\s;&|(])pip3?\s+install\b[^;\n&|]*?\s(?:-e\s+)?\.(?=$|[\s;&|)])/m.test(run)) files.push('setup.py', 'setup.cfg', 'pyproject.toml');
  return files;
}

/** Job signals for runs of the workflow on one branch; expressions are evaluated for that branch. */
function workflowSignals(content: string, branch: string): WorkflowJobSignal[] {
  const unknown: WorkflowJobSignal[] = [{ job: 'unknown', executesCode: false, privileged: false, unsupported: true, executed: [], text: [], identities: [] }];
  if (Buffer.byteLength(content) > 262144) return unknown;
  const document = parseDocument(content, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) return unknown;
  let value: any;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { return unknown; }
  if (!record(value) || !record(value.jobs)) return unknown;
  const shared = strings([value.env, value.defaults]);
  return Object.entries(value.jobs).map(([id, job]): WorkflowJobSignal => {
    if (!record(job)) return { ...unknown[0]!, job: id };
    // Job-level permissions replace workflow-level permissions; omitted keys
    // are not inherited. Never join credentials from one job to another's code.
    const permissions = Object.hasOwn(job, 'permissions') ? job.permissions : value.permissions;
    const privileged = permissions === 'write-all' || record(permissions) && Object.values(permissions).includes('write') ||
      referencesSecret(value.env) || referencesSecret(job.env) || referencesSecret(job.steps);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const executed: string[] = [];
    const identities: WorkflowIdentityReference[] = [];
    let unsupported = job.uses !== undefined;
    let checkout = false;
    for (const step of steps) {
      if (!record(step)) { unsupported = true; continue; }
      if (typeof step.uses === 'string' && /^actions\/checkout@/.test(step.uses)) {
        // Explicit refs, other repositories and alternate paths need a separate
        // provenance analysis. They cannot establish this branch's script control.
        checkout = !step.with || record(step.with) &&
          !['ref', 'repository', 'path'].some(key => Object.hasOwn(step.with, key));
        if (!checkout) unsupported = true;
      }
      // Local actions run repository files whose contents this check does not read.
      if (typeof step.uses === 'string' && step.uses.startsWith('./')) unsupported = true;
      identities.push(...stepIdentities(step, { branch, env: [step.env, job.env, value.env], on: value.on }));
      if (typeof step.run !== 'string') continue;
      if (step['working-directory'] !== undefined || job.defaults?.run?.['working-directory'] !== undefined ||
          value.defaults?.run?.['working-directory'] !== undefined) { unsupported = true; continue; }
      if (!checkout) continue;
      // Only literal repository scripts and recognized root manifests count, after a matching checkout.
      executed.push(...executedInputs(step.run));
    }
    const environment = job.environment === undefined ? undefined
      : literal(record(job.environment) ? job.environment.name : job.environment) ?? null;
    return { job: id, executesCode: steps.some(step => record(step) && (typeof step.run === 'string' || typeof step.uses === 'string')),
      privileged, unsupported, executed: [...new Set(executed)], text: [...shared, ...strings(job)], identities,
      ...(environment === undefined ? {} : { environment }) };
  });
}

const escapeExpression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A literal mention of the file, a parent directory, or a glob over its extension. */
function mentions(texts: readonly string[], path: string): boolean {
  const parents: string[] = [];
  for (let dir = posix.dirname(path); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) parents.push(dir);
  const file = new RegExp(`(?:^|[^A-Za-z0-9_.-])(?:\\./)?${escapeExpression(path)}(?![A-Za-z0-9_./-])`);
  const folders = parents.map(dir => new RegExp(`(?:^|[^A-Za-z0-9_.-])(?:\\./)?${escapeExpression(dir)}/?(?![A-Za-z0-9_.-]|/[A-Za-z0-9_.-])`));
  const extension = posix.extname(path);
  return texts.some(text => file.test(text) || folders.some(folder => folder.test(text)) || !!extension && text.includes(`*${extension}`));
}
/** Why a writable path cannot be called inert, or undefined when it is documentation/static content. */
function activeReason(path: string): string | undefined {
  if (path.startsWith('.github/')) return `${path} is a workflow or action definition.`;
  const name = posix.basename(path);
  if (implicitPatterns.some(pattern => pattern.test(name))) return `${path} is a manifest or configuration file that tools run or load implicitly.`;
  if (!inertFileExtensions.includes(posix.extname(name).toLowerCase())) return `${path} may be run or loaded by repository code.`;
  return undefined;
}

/** Potential CI authority paths, not an assertion that a push can bypass every protection. */
export function githubPermissionPreflight(collect?: GitHubEvidenceCollector, options: {
  /** Trusted cloud adapters that assess identities which workflow jobs request. */
  workflowIdentity?: WorkflowIdentityAssessors;
} = {}): PreflightInspector {
  const assessorFor = (provider: string): WorkflowIdentityAssessor | undefined => typeof options.workflowIdentity === 'function'
    ? options.workflowIdentity : options.workflowIdentity && Object.hasOwn(options.workflowIdentity, provider) ? options.workflowIdentity[provider] : undefined;
  const ids = ['github.coverage', 'github.workflow-definition', 'github.workflow-execution'];
  return {
    provider: 'github', checks: ids,
    async inspect(input: PreflightInput) {
      const tools = input.tools.filter(tool => tool.provider === 'github');
      const base = (id: string): PreflightCheck => ({ id, provider: 'github', status: 'not-applicable', severity: 'info',
        summary: 'No repository-write capability is exposed by these tools.', tools: tools.map(tool => tool.name), path: [], evidence: [],
        limitations: ['Known-pattern snapshot assessment, not complete GitHub Actions reachability.'] });
      const unknown = tools.filter(tool => !['contents.read', 'contents.write'].includes(tool.operation));
      const results: PreflightCheck[] = [{ ...base(ids[0]!), status: unknown.length ? 'unknown' : 'not-applicable',
        summary: unknown.length ? `Unsupported operations: ${unknown.map(tool => tool.operation).join(', ')}` :
          'Repository contents operations are recognized; checks report their own evidence coverage.' }];
      const writes = input.grants.filter(grant => grant.subject === input.subject && tools.some(tool => tool.name === grant.tool && tool.operation === 'contents.write'));
      if (!writes.length) return [...results, base(ids[1]!), base(ids[2]!)];
      const definition = writes.filter(grant => grant.resources.path?.some(path => typeof path === 'string' &&
        (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/'))));
      const evidence: GitHubRepositoryEvidence[] = [];
      let incomplete = false;
      const seen = new Set<string>();
      for (const grant of writes) {
        const repositories = grant.resources.repository;
        const branches = grant.resources.branch;
        if (!repositories?.length || !branches?.length || !grant.resources.path?.length) { incomplete = true; continue; }
        for (const repository of repositories) for (const branch of branches) {
          if (typeof repository !== 'string' || typeof branch !== 'string') { incomplete = true; continue; }
          const key = `${repository}\n${branch}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 64 || !collect) { incomplete = true; continue; }
          try {
            const item = await collect(repository, branch, input.signal);
            if (item.repository !== repository || item.branch !== branch || !item.complete || typeof item.actionsEnabled !== 'boolean' ||
                !Array.isArray(item.workflows)) { incomplete = true; continue; }
            evidence.push(item);
          } catch { incomplete = true; }
        }
      }
      const refs: PreflightEvidence[] = evidence.map(item => ({ source: item.source, resource: `${item.repository}@${item.branch}`, observedAt: item.observedAt }));
      const disabled = !incomplete && evidence.length > 0 && evidence.every(item => item.actionsEnabled === false);
      results.push({ ...base(ids[1]!), status: !definition.length ? 'not-applicable' : disabled ? 'clear' : 'unknown',
        severity: definition.length && !disabled ? 'warning' : 'info', evidence: refs,
        summary: !definition.length ? 'The exact path grants exclude workflow and local action definitions.' : disabled ?
          'Actions is disabled in every inspected repository; enabling Actions through other channels is outside this check.' :
          'The agent can request workflow or local action definition changes. Provider workflow-write rights, triggers and protections require verification.',
        path: definition.length ? ['contents.write', '.github/workflows/* or .github/actions/*', 'potential new workflow execution'] : [] });

      const signals = evidence.flatMap(item => item.actionsEnabled ? item.workflows.flatMap(workflow => workflowSignals(workflow.content, item.branch).map(job => ({ ...job,
        repository: item.repository, branch: item.branch, workflow: `${item.repository}@${item.branch}:${workflow.path}#${job.job}` }))) : []);
      type Signal = typeof signals[number];
      const writable = (item: Signal) => writes.filter(grant => grant.resources.repository?.includes(item.repository) &&
        grant.resources.branch?.includes(item.branch)).flatMap(grant => (grant.resources.path ?? []).filter((path): path is string => typeof path === 'string'));
      const risky = signals.filter(item => item.executesCode && item.privileged);
      const controlled = risky.map(item => ({ item, paths: [...new Set(writes.filter(grant => grant.resources.repository?.includes(item.repository) &&
        grant.resources.branch?.includes(item.branch) && !grant.arguments.content).flatMap(grant =>
        (grant.resources.path ?? []).filter(path => typeof path === 'string' && item.executed.includes(path))))] as string[] }))
        .filter(entry => entry.paths.length);

      // Clear needs complete evidence, supported workflows and only inert, unreferenced writes.
      const blockers: string[] = [];
      if (incomplete || evidence.length !== seen.size) blockers.push('Repository evidence collection is incomplete.');
      if (signals.some(item => item.unsupported)) blockers.push('Some workflow syntax, reusable workflows or local actions are unsupported.');
      for (const item of evidence.filter(entry => entry.actionsEnabled)) {
        const scoped = signals.filter(signal => signal.repository === item.repository && signal.branch === item.branch);
        const paths = writes.filter(grant => grant.resources.repository?.includes(item.repository) && grant.resources.branch?.includes(item.branch))
          .flatMap(grant => grant.resources.path ?? []);
        for (const path of new Set(paths)) {
          if (typeof path !== 'string') { blockers.push('A path grant is not an exact string.'); continue; }
          const reason = activeReason(path);
          if (reason) { blockers.push(reason); continue; }
          const reference = scoped.find(signal => mentions(signal.text, path));
          if (reference) blockers.push(`${path} is referenced by ${reference.workflow}.`);
        }
      }
      const inert = !disabled && !controlled.length && !blockers.length && evidence.length > 0;

      // Ask the trusted cloud adapter about identities on the reported jobs only.
      const reported: Signal[] = controlled.length ? controlled.map(entry => entry.item) : inert || disabled ? [] : risky;
      const assessments = new Map<string, WorkflowIdentityAssessment | undefined>();
      const identityLimits: string[] = [];
      const identityEvidence: PreflightEvidence[] = [];
      const subjectOf = (item: Signal) => item.environment === null ? undefined : item.environment
        ? `repo:${item.repository}:environment:${item.environment}` : `repo:${item.repository}:ref:refs/heads/${item.branch}`;
      const keyOf = (item: Signal, reference: WorkflowIdentityReference) =>
        [reference.provider, reference.identity, reference.federation ?? '', subjectOf(item) ?? '', reference.oidc].join('\n');
      for (const item of reported) for (const reference of item.identities) {
        if (!reference.identity) {
          identityLimits.push(reference.staticKey
            ? `${item.workflow} uses a long-lived ${reference.provider} key from ${reference.staticKey}. A stored key is not bound to this repository, branch or workflow, and the workflow does not establish whose key it is.`
            : `${item.workflow} requests ${reference.provider} credentials from a value this check cannot resolve.`);
          continue;
        }
        if (reference.alternatives) identityLimits.push(`${item.workflow} can request ${reference.alternatives} ${reference.provider} identities on refs/heads/${item.branch}, depending on workflow expressions; each is listed.`);
        const key = keyOf(item, reference);
        if (assessments.has(key)) continue;
        const assess = assessorFor(reference.provider);
        if (!assess || assessments.size >= MAX_IDENTITY_ASSESSMENTS) {
          assessments.set(key, undefined);
          identityLimits.push(assess ? 'Workflow identity assessment limit reached.'
            : `No workflow identity adapter was configured for ${reference.provider}; its cloud authority is not assessed.`);
          continue;
        }
        const subject = subjectOf(item);
        try {
          const result = await assess({ provider: reference.provider, identity: reference.identity, repository: item.repository,
            branch: item.branch, workflow: item.workflow, oidc: reference.oidc, ...(reference.region ? { region: reference.region } : {}),
            ...(reference.federation ? { federation: reference.federation } : {}), ...(subject ? { oidcSubject: subject } : {}) }, input.signal);
          const valid = result && result.identity === reference.identity && ['admits', 'excludes', 'unknown'].includes(result.trust) &&
            Array.isArray(result.potentialAuthority) && Array.isArray(result.declaredAuthority) && Array.isArray(result.evidence) && Array.isArray(result.limitations);
          assessments.set(key, valid ? result : undefined);
          if (!valid) { identityLimits.push(`The ${reference.provider} identity adapter returned an invalid result.`); continue; }
          identityEvidence.push(...result.evidence.filter(entry => typeof entry?.source === 'string' && entry.source &&
            typeof entry.resource === 'string' && entry.resource && Number.isSafeInteger(entry.observedAt)));
          identityLimits.push(...result.limitations.filter(entry => typeof entry === 'string'));
        } catch {
          // Provider errors can contain credentials. Only fixed messages are reported.
          assessments.set(key, undefined);
          identityLimits.push(`The ${reference.provider} identity assessment failed.`);
        }
      }
      const authorityLine = (entry: WorkflowIdentityAuthority, note: string) =>
        `${entry.provider}:${entry.operation} ${Object.values(entry.resources).flat().join(', ')} (${note})`;
      const identityPath = (item: Signal) => item.identities.flatMap(reference => {
        if (!reference.identity) return [reference.staticKey
          ? `uses a long-lived ${reference.provider} key from ${reference.staticKey} (identity unresolved)`
          : `requests ${reference.provider} credentials from ${reference.unresolved} (unresolved)`];
        const lines = [`assumes ${reference.provider} ${reference.identity}${reference.region ? ` in ${reference.region}` : ''}` +
          `${reference.oidc ? ' via OIDC' : ' with stored keys'}${reference.federation ? ` through ${reference.federation}` : ''}`];
        const result = assessments.get(keyOf(item, reference));
        if (!result) return [...lines, 'identity authority not assessed'];
        const subject = subjectOf(item);
        // AWS roles have a trust policy; GCP service accounts admit federated tokens through IAM bindings.
        const trust = reference.provider === 'gcp' ? ['service account bindings admit', 'service account bindings do not admit']
          : ['trust policy admits', 'trust policy does not admit'];
        lines.push(result.trust === 'admits' ? `${trust[0]} ${subject}` : result.trust === 'excludes'
          ? `${trust[1]} ${subject}` : `${reference.provider === 'gcp' ? 'service account binding' : 'trust policy'} result not established`);
        const evaluated = new Set(result.potentialAuthority.map(entry => authorityLine(entry, '')));
        const declared = result.declaredAuthority.filter(entry => !evaluated.has(authorityLine(entry, '')));
        const authority = [...result.potentialAuthority.map(entry => authorityLine(entry, 'provider-evaluated allow')),
          ...declared.map(entry => authorityLine(entry, 'declared in policy, not provider-evaluated'))];
        lines.push(...authority.slice(0, MAX_AUTHORITY_LINES));
        if (authority.length > MAX_AUTHORITY_LINES) lines.push(`${authority.length - MAX_AUTHORITY_LINES} more authority entries`);
        if (!authority.length) lines.push('no exact authority established');
        return lines;
      });
      const path = controlled.length
        ? controlled.flatMap(({ item, paths }) => [...paths.map(path => `contents.write ${item.repository}@${item.branch}:${path}`), item.workflow, ...identityPath(item)])
        : reported.flatMap(item => [item.workflow, ...identityPath(item)]);
      const requested = [...new Set(controlled.flatMap(({ item }) => item.identities.flatMap(reference => reference.identity ? [reference.identity]
        : reference.staticKey ? [`a long-lived ${reference.provider} key from ${reference.staticKey}`] : [])))];
      const status = disabled || inert ? 'clear' : controlled.length ? 'finding' : 'unknown';
      results.push({ ...base(ids[2]!), status, severity: status === 'clear' ? 'info' : risky.length ? 'high' : 'warning',
        evidence: [...refs, ...identityEvidence],
        summary: disabled ? 'Actions is disabled in every inspected repository.' : inert ?
          'No recognized execution path: every agent-writable file is inert documentation or static content that no inspected workflow references.' :
          controlled.length ? requested.length
            ? `Potential escalation: a privileged workflow job runs an agent-writable file and requests ${requested.join(', ')}. Triggers and protections still need verification.`
            : 'Potential escalation: a workflow references an agent-writable script and privileged credentials or OIDC. Triggers and protections still need verification.' :
          risky.length ? 'Privileged workflows exist alongside agent repository writes. Execution of agent-controlled content and independent protections need verification.' :
          'Repository writes may affect executable CI inputs; absence of a recognized workflow pattern does not establish safety.',
        path, limitations: [...new Set([
          'Trigger filters, workflow expressions, script contents, environment approvals and custom OIDC subject claims are not fully resolved.',
          ...(inert ? ['Clear covers execution of agent-writable files by inspected workflows. It does not cover data read by scripts, publication of written content, workflows on other branches or later workflow changes.'] : []),
          ...(writes.some(grant => grant.arguments.content) ? ['Fixed content grants do not establish arbitrary script control; allowed content has not been analyzed.'] : []),
          ...(status === 'unknown' || status === 'finding' ? blockers : []),
          ...identityLimits,
        ])] });
      return results;
    },
  };
}

/** Uses ordinary GitHub read APIs. Requires Actions-read and Contents-read on the inspected repositories. */
export function githubEvidenceCollector(options: { token: () => Promise<string>; fetch?: typeof fetch }): GitHubEvidenceCollector {
  return async (repository, branch, signal) => {
    if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw Error('Invalid repository');
    const token = await options.token();
    const read = async (path: string, optional = false): Promise<any> => {
      const response = await (options.fetch ?? fetch)(new URL(path, 'https://api.github.com'), { redirect: 'error', signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
      if (optional && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw Error('GitHub evidence unavailable'); }
      return readProviderJson(response);
    };
    const permissions = await read(`/repos/${repository}/actions/permissions`);
    if (typeof permissions.enabled !== 'boolean') throw Error('Invalid Actions evidence');
    // Resolve the branch once and read every file at that immutable commit.
    const commit = await read(`/repos/${repository}/commits/${encodeURIComponent(branch)}`);
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw Error('Invalid commit evidence');
    const entries = await read(`/repos/${repository}/contents/.github/workflows?ref=${commit.sha}`, true);
    if (entries !== null && !Array.isArray(entries)) throw Error('Invalid workflow evidence');
    const workflows: Array<{ path: string; content: string }> = [];
    let complete = true;
    for (const entry of entries ?? []) {
      if (entry.type !== 'file') { complete = false; continue; }
      if (!/\.ya?ml$/.test(entry.path)) continue;
      if (workflows.length >= 64 || !/^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(entry.path)) { complete = false; continue; }
      const file = await read(`/repos/${repository}/contents/${entry.path}?ref=${commit.sha}`);
      if (file.encoding !== 'base64' || typeof file.content !== 'string') { complete = false; continue; }
      workflows.push({ path: entry.path, content: Buffer.from(file.content, 'base64').toString('utf8') });
    }
    return { repository, branch, actionsEnabled: permissions.enabled, observedAt: Date.now(),
      source: `https://api.github.com/repos/${repository}/commits/${commit.sha}`, workflows, complete };
  };
}
