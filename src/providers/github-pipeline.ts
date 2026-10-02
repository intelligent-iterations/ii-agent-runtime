import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGitHubApi, getRecord, record, GitHubError, type GitHubApi } from './github-http.js';
import { runTrustedProcess, type ProcessRunner } from './process.js';
import { createInstallationIssuer, type InstallationToken } from './github-app.js';
import type { ActionsIdentity } from './github-authorization.js';
import { authorizeIssueTask, githubOrderedAdmissionStore, type IssueRequestReader, type IssueTriggerOptions } from './github-issue.js';
import { githubConsumerNames } from './github-names.js';
import { consumerNames, type ConsumerIdentity } from '../runtime/consumer.js';
import { reserveInvocationOrdered } from '../runtime/admission.js';
import type { CompiledConfiguration } from '../runtime/configuration.js';
import { ChangeRequestRefused, type Authorization, type Intake, type SourceHost } from '../pipeline/ports.js';

/**
 * A shallow clone of one branch on the trusted host, with the token passed through git's environment so it never
 * appears in arguments or in the clone's configuration. Submodules and hooks are not run.
 */
export async function cloneRepository(input: { repository: string; base?: string; token: string; directory: string; executablePath: string; process?: ProcessRunner }) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`;
  await (input.process ?? runTrustedProcess)({ command: 'git', cwd: input.directory, timeoutMs: 300000, maxOutputBytes: 1048576,
    args: ['clone', '--depth=1', '--single-branch', '--no-recurse-submodules', '--no-tags', ...(input.base ? ['--branch', input.base] : []),
      `https://github.com/${input.repository}.git`, join(input.directory, 'repository')],
    env: { PATH: input.executablePath, HOME: input.directory, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header,
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' } });
  return join(input.directory, 'repository');
}

export const githubServices = { createGitHubApi, createInstallationIssuer, authorizeIssueTask, githubOrderedAdmissionStore,
  reserveInvocationOrdered, cloneRepository };
export type GitHubServices = typeof githubServices;
type Issuer = ReturnType<typeof createInstallationIssuer>;

const encodeBranch = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

/** What the run actually pushed: the task branch's commits and files ahead of the base, read from GitHub. */
export async function pushedWork(api: GitHubApi, repository: string, branch: string, base: string) {
  const found = await api.request('GET', `/repos/${repository}/branches/${encodeBranch(branch)}`);
  if (found.status === 404) return { verified: true, branch, base, commits: 0, files: 0 };
  if (found.status !== 200) throw Error('Branch lookup failed');
  const compare = await getRecord(api, `/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`);
  const commits = Number(compare.ahead_by);
  return { verified: true, branch, base, commits: Number.isSafeInteger(commits) ? commits : 0, files: Array.isArray(compare.files) ? compare.files.length : 0 };
}

/** Opens the pull request for pushed work; an existing one is reused. A refusal keeps GitHub's status and short reason. */
export async function openPullRequest(api: GitHubApi, repository: string, input: { branch: string; base: string; title: string; body: string }) {
  const created = await api.request('POST', `/repos/${repository}/pulls`, { title: input.title, head: input.branch, base: input.base, body: input.body });
  if (created.status === 201) return { number: Number(record(created.body).number), url: String(record(created.body).html_url) };
  const existing = await api.request('GET', `/repos/${repository}/pulls?state=open&head=${repository.split('/')[0]}:${encodeURIComponent(input.branch)}`);
  const [open] = Array.isArray(existing.body) ? existing.body.map(record) : [];
  if (open) return { number: Number(open.number), url: String(open.html_url) };
  const detail = record(created.body);
  const errors = Array.isArray(detail.errors) ? detail.errors.map(entry => record(entry).message).filter(message => typeof message === 'string') : [];
  // GitHub-authored text, never repository content; stripped of markup for the reply.
  const reason = [detail.message, ...errors].filter(text => typeof text === 'string' && text).join(': ');
  throw new ChangeRequestRefused(created.status, reason.replace(/[^\x20-\x7e]/g, ' ').replace(/[`<>[\]]/g, '').slice(0, 200));
}

/**
 * The GitHub App installation, held in one closure: the intake reads with a token that cannot write, the worker gateway
 * gets repository-scoped tokens, and the change-request token stays here. The App key is dropped once grants exist.
 */
export function githubSourceHost(compiled: CompiledConfiguration, options: { consumer: ConsumerIdentity; privateKey: string; scratch: string;
  executablePath: string; services: GitHubServices }): SourceHost & { reader(): Promise<InstallationToken>; revoke(token: string): Promise<void> } {
  const config = compiled.configuration;
  const target = config.source.repository;
  let privateKey = options.privateKey;
  let issuer: Issuer | undefined;
  let reader: InstallationToken | undefined;
  let writer: InstallationToken | undefined;
  let delivery: InstallationToken | undefined;
  const open = () => issuer ??= options.services.createInstallationIssuer({ appId: config.source.appId, installationId: config.source.installationId,
    owner: target.split('/')[0]!, ...(config.source.requireAppOwner ? { requireAppOwner: true } : {}), privateKey: () => privateKey });
  const api = (token: string, maxRequests: number) => options.services.createGitHubApi({ credential: () => token, maxRequests });
  return {
    name: 'github-tokens',
    target,
    author: { name: consumerNames(options.consumer).authorName, email: githubConsumerNames(options.consumer).authorEmail },
    workerAccess: endpoint => ({ remotePrefix: 'https://github.com/', gatewayPrefix: `${endpoint}/git/`,
      notes: `GitHub API access is available at ${endpoint}/github/OWNER/REPOSITORY/PATH using the AGENT_GATEWAY_TOKEN bearer token. ` +
        'Git remotes at https://github.com/ are configured through the same gateway. Only configured repositories are accessible.' }),
    async reader() { return reader ??= await open().issue(target, { contents: 'read' }); },
    async revoke(token) { await open().revoke(token); },
    async baseExists(base) {
      const found = await api((await this.reader()).token, 5).request('GET', `/repos/${target}/branches/${encodeBranch(base)}`);
      if (found.status === 404) return false;
      if (found.status !== 200) throw Error('Base branch lookup failed');
      return true;
    },
    async checkout(base) {
      // Read-only and on the host: the worker receives files, never the token that fetched them.
      const owner = randomBytes(16).toString('hex');
      const directory = join(options.scratch, `agent-runtime-source-${owner}`);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
      const dispose = async () => {
        if (realpathSync(directory) !== directory || readFileSync(join(directory, '.owner'), 'utf8') !== owner) throw Error('Checkout ownership changed');
        rmSync(directory, { recursive: true });
      };
      try {
        const path = await options.services.cloneRepository({ repository: target, ...(base ? { base } : {}), token: (await this.reader()).token,
          directory, executablePath: options.executablePath });
        return { directory: path, dispose };
      } catch (error) { await dispose().catch(() => undefined); throw error; }
    },
    async workerGrants() {
      // Only what the configuration grants; pushing the task branch needs contents: write and nothing else.
      const grants = [writer = await open().issue(target, config.source.permissions ?? { contents: 'write' })];
      for (const grant of config.source.additionalRepositories) grants.push(await open().issue(grant.repository, grant.permissions));
      // Apps created before pull requests were added lack the permission; the run then still pushes. Contents read is
      // needed too: without it GitHub refuses with 422 "not all refs are readable", although its table lists only pull requests.
      delivery = await open().issue(target, { contents: 'read', pull_requests: 'write' }).catch(() => undefined);
      privateKey = '';
      return grants;
    },
    canDeliver: () => delivery !== undefined,
    async verifyPush(branch, base) {
      if (!writer) throw Error('No run credential');
      return pushedWork(api(writer.token, 5), target, branch, base);
    },
    async openChangeRequest(input) {
      if (!delivery) throw Error('No pull request credential');
      return openPullRequest(api(delivery.token, 3), target, input);
    },
    async close() { privateKey = ''; if (issuer) await issuer.close(); },
  };
}

const decision = (result: { decision: { allowed: boolean; reason: string; subjectId: string }; evidence: { currentInputDigest: string; subjectId: string } }) =>
  ({ allowed: result.decision.allowed, reason: result.decision.reason, decision: result.decision, subjectId: result.evidence.subjectId, inputDigest: result.evidence.currentInputDigest });

/** A task filed as an issue in the control repository whose workflow `run` is executing, naming the repository to change. */
export function githubIssueIntake(compiled: CompiledConfiguration, options: { api: GitHubApi; run: ActionsIdentity; event: unknown;
  current: CompiledConfiguration; source: ReturnType<typeof githubSourceHost>; consumer: ConsumerIdentity; readRequest: IssueRequestReader;
  trigger: IssueTriggerOptions; services: GitHubServices }): Intake {
  const target = compiled.configuration.source.repository;
  let readerToken: string | undefined;
  let unreachable = false;
  const check = async (): Promise<Authorization> => {
    const reader = await options.source.reader().catch(error => {
      if (error instanceof GitHubError && error.code === 'ISSUANCE') unreachable = true;
      throw error;
    });
    readerToken = reader.token;
    // Verification reads the target with a token that cannot write; the agent's write token comes after admission.
    const result = await options.services.authorizeIssueTask({ control: options.api, target: options.services.createGitHubApi({ credential: () => reader.token, maxRequests: 60 }),
      run: options.run, event: options.event, repository: target, compiled, current: options.current, consumer: options.consumer,
      readRequest: options.readRequest, options: options.trigger });
    return { ...decision(result), task: result.task, base: result.base, defaultBranch: result.defaultBranch };
  };
  return {
    runId: String(options.run.runId), attempt: options.run.attempt, resource: options.run.repository,
    get unreachable() { return unreachable; },
    authorize: check,
    async confirm(first) {
      const again = await check();
      if (!again.allowed || again.inputDigest !== first.inputDigest) return { ...again, allowed: false };
      if (readerToken) await options.source.revoke(readerToken);
      return again;
    },
    // One budget per control repository: every launch reserves against the repository that received the issue.
    admit: (first, policyDigest, now) => options.services.reserveInvocationOrdered(options.services.githubOrderedAdmissionStore(options.api, options.run, options.consumer),
      compiled.configuration.limits, { resource: options.run.repository, subjectId: first.subjectId, runId: String(options.run.runId),
        attempt: options.run.attempt, inputDigest: first.inputDigest, policyDigest }, now),
  };
}
