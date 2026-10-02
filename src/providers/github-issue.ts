import { canonicalJson, type CompiledConfiguration } from '../runtime/configuration.js';
import { authorizeInvocation, type InvocationEvidence, type InvocationPolicy } from '../runtime/authorization.js';
import type { OrderedAdmissionStore, Reservation } from '../runtime/admission.js';
import type { ConsumerIdentity } from '../runtime/consumer.js';
import type { PipelineTask } from '../pipeline/ports.js';
import { getRecord, GitHubError, positiveId, record, type GitHubApi } from './github-http.js';
import { capabilitiesForPermission, issueInput, login, type ActionsIdentity } from './github-authorization.js';
import { githubConsumerNames } from './github-names.js';

/**
 * GitHub issue intake: a task is an issue filed in a control repository, whose own workflow holds the App key and the
 * model key. The issue names the repository to change (the target), and the filer must currently have the configured
 * access to it. The consumer owns the issue form, so it supplies `readRequest`: the repository and base branch an issue
 * body names.
 */
export type IssueRequestReader = (body: unknown) => { repository: string | undefined; base: string | undefined | null };

export type SubmitAction = 'opened' | 'reopened' | 'edited';
/** How a consumer uses issues. Everything here is the consumer's choice; the defaults suit a separate control repository. */
export interface IssueTriggerOptions {
  /** Issue actions that submit the task as the person acting. Defaults to opened and reopened (reopening retries). */
  submitActions?: SubmitAction[];
  /** Whether adding a label counts as approval, for the maintainer-approval launch policy. Defaults to true. */
  approveByLabel?: boolean;
  /** Runs of the consumer's workflow, and attempts per run, that may start before any admission check. */
  startLimits: { maxRunNumber: number; maxAttempts: number };
  /**
   * Allow the control repository itself to be the target, for consumers that take issues in the repository they
   * change. Off by default: the agent then holds a write token for the repository whose workflow launched it. An App
   * token cannot change workflow files without the `workflows` permission, and the run only pushes a task branch.
   */
  allowControlTarget?: boolean;
}

const SUBMIT_ACTIONS: SubmitAction[] = ['opened', 'reopened', 'edited'];
export function issueTriggerActions(options: IssueTriggerOptions): { submit: SubmitAction[]; approve: string[] } {
  const submit = options.submitActions ?? ['opened', 'reopened'];
  if (!submit.length || submit.some(action => !SUBMIT_ACTIONS.includes(action))) throw new GitHubError('TRIGGER_OPTIONS');
  return { submit, approve: options.approveByLabel === false ? [] : ['labeled'] };
}

/** The task as the pipeline sees it: `issue-<number>` names the branch, and the agent reads `Issue #<number>`. */
export function issueTask(issue: Record<string, unknown>): PipelineTask {
  const number = positiveId(issue.number);
  return { reference: `issue-${number}`, label: `Issue #${number}`, title: String(issue.title), body: issue.body === null ? '' : String(issue.body) };
}

/**
 * Verify an issue event against authenticated GitHub state. `control` reads the control repository with its Actions
 * token; `target` reads the named repository with a short-lived, read-only App token. `compiled` is the policy at the
 * workflow commit and `current` the policy on the control repository's default branch, both compiled for this target.
 */
export async function authorizeIssueTask(input: {
  control: GitHubApi; target: GitHubApi; run: ActionsIdentity; event: unknown; repository: string;
  compiled: CompiledConfiguration; current: CompiledConfiguration; consumer: ConsumerIdentity; readRequest: IssueRequestReader;
  options: IssueTriggerOptions; now?: () => number;
}) {
  const { control, target, run: identity, repository, compiled, current, readRequest, options } = input;
  const now = input.now ?? Date.now;
  const started = now();
  const workflowPath = githubConsumerNames(input.consumer).workflowPath;
  const actions = issueTriggerActions(options);
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(identity.repository) || !/^[a-f0-9]{40}$/.test(identity.workflowSha)) throw new GitHubError('RUN_IDENTITY');
  positiveId(identity.repositoryId); positiveId(identity.runId); positiveId(identity.attempt);
  positiveId(options.startLimits.maxRunNumber); positiveId(options.startLimits.maxAttempts);
  if ((repository === identity.repository && options.allowControlTarget !== true) || repository !== compiled.configuration.source.repository ||
    repository !== current.configuration.source.repository) throw new GitHubError('TARGET_MISMATCH');
  // No additional grant may reach the control repository, or an agent could change the workflow and policy that launch it.
  for (const policy of [compiled, current]) {
    if (policy.configuration.source.additionalRepositories.some(grant => grant.repository === identity.repository)) throw new GitHubError('TARGET_MISMATCH');
  }
  const event = record(input.event);
  const eventRepo = record(event.repository);
  const action = String(event.action);
  if (eventRepo.id !== identity.repositoryId || String(eventRepo.full_name).toLowerCase() !== identity.repository ||
    ![...actions.submit, ...actions.approve].includes(action)) throw new GitHubError('EVENT_IDENTITY');
  const approval = actions.approve.includes(action);
  const originalIssue = record(event.issue);
  const originalSender = record(event.sender);
  const controlRepo = await getRecord(control, `/repos/${identity.repository}`);
  if (controlRepo.id !== identity.repositoryId || typeof controlRepo.default_branch !== 'string') throw new GitHubError('REPOSITORY_STATE');
  const run = await getRecord(control, `/repos/${identity.repository}/actions/runs/${identity.runId}`);
  if (positiveId(run.run_number) > options.startLimits.maxRunNumber || identity.attempt > options.startLimits.maxAttempts) throw new GitHubError('WORKFLOW_START_LIMIT');
  const actor = record(run.actor);
  const triggering = record(run.triggering_actor);
  if (run.id !== identity.runId || run.run_attempt !== identity.attempt || run.event !== 'issues' || run.head_sha !== identity.workflowSha ||
    actor.id !== originalSender.id || String(actor.login).toLowerCase() !== String(originalSender.login).toLowerCase() ||
    ![workflowPath, `${workflowPath}@refs/heads/${controlRepo.default_branch}`].includes(String(run.path))) throw new GitHubError('RUN_IDENTITY');
  const issue = await getRecord(control, `/repos/${identity.repository}/issues/${positiveId(originalIssue.number)}`);
  if (issue.id !== originalIssue.id || !Array.isArray(issue.labels)) throw new GitHubError('ISSUE_IDENTITY');
  // The target is part of the task: it must be the one in the event and still the one on the issue.
  const requested = readRequest(originalIssue.body);
  const currentRequest = readRequest(issue.body);
  if (requested.repository !== repository || currentRequest.repository !== repository ||
    requested.base !== currentRequest.base || currentRequest.base === null) throw new GitHubError('TARGET_BINDING');
  const destination = await getRecord(target, `/repos/${repository}`);
  if (String(destination.full_name).toLowerCase() !== repository || destination.archived !== false || destination.disabled !== false ||
    typeof destination.default_branch !== 'string') throw new GitHubError('TARGET_STATE');
  const targetId = positiveId(destination.id);
  const selection = current.configuration.launchPolicy;
  async function permissions(user: Record<string, unknown>) {
    const value = await getRecord(target, `/repos/${repository}/collaborators/${encodeURIComponent(login(user.login))}/permission`);
    if (positiveId(record(value.user).id) !== positiveId(user.id)) throw new GitHubError('PERMISSION_IDENTITY');
    return capabilitiesForPermission(value.permission, value.role_name);
  }
  const evidence: InvocationEvidence = {
    resource: `repository:${targetId}`, subjectId: `issue:${positiveId(issue.id)}`,
    // A submission counts only when the author makes it; reopening, for example, is how an author retries.
    event: approval ? 'approved' : 'submitted', actorId: `user:${positiveId(actor.id)}`,
    authorId: `user:${positiveId(record(issue.user).id)}`,
    actorCapabilities: selection.mode === 'any-author' ? [] : await permissions(actor),
    currentLabels: issue.labels.map(label => typeof label === 'string' ? label : String(record(label).name)),
    ...(approval ? { label: String(record(event.label).name) } : {}),
    originalInputDigest: issueInput(originalIssue, identity.repositoryId), currentInputDigest: issueInput(issue, identity.repositoryId),
    policyDigest: compiled.setupDigest, currentPolicyDigest: current.setupDigest,
    observedAt: started, open: issue.state === 'open', runId: String(identity.runId), attempt: identity.attempt,
    ...(identity.attempt > 1 ? { rerun: { actorId: `user:${positiveId(triggering.id)}`, capabilities: await permissions(triggering) } } : {}),
  };
  const policy: InvocationPolicy = selection.mode === 'any-author' ? selection : selection.mode === 'maintainer-approval'
    ? { mode: selection.mode, requiredCapability: `repository:${selection.minimumPermission}`, label: selection.label }
    : { mode: selection.mode, requiredCapability: `repository:${selection.minimumPermission}` };
  // The branch the work starts from and is delivered into: the one the issue names, or the target's default branch.
  const base = currentRequest.base ?? String(destination.default_branch);
  return { decision: authorizeInvocation(policy, evidence.resource, evidence, now()), evidence, targetId, base, defaultBranch: String(destination.default_branch),
    task: issueTask(issue) };
}


/**
 * Reservations live in the control repository as deployments created by its own Actions token; deployment IDs give the total order
 * that ordered admission needs, so launches never hold a concurrency group and GitHub never cancels a waiting run.
 * Each launcher records its outcome as a second deployment that names the reservation it decides.
 */
export function githubOrderedAdmissionStore(api: GitHubApi, identity: ActionsIdentity, consumer: ConsumerIdentity): OrderedAdmissionStore {
  const names = githubConsumerNames(consumer);
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(identity.repository) || !/^[a-f0-9]{40}$/.test(identity.workflowSha)) throw new GitHubError('ADMISSION_IDENTITY');
  positiveId(identity.repositoryId); positiveId(identity.runId); positiveId(identity.attempt);
  const base = `/repos/${identity.repository}`;
  const environment = names.ledgerEnvironment;
  const reserve = names.reserveTask, decide = names.decideTask;
  let own: number | undefined;
  let settled = false;
  let verified = false;
  async function verifyRun() {
    if (verified) return;
    const run = await getRecord(api, `${base}/actions/runs/${identity.runId}`);
    if (run.id !== identity.runId || run.run_attempt !== identity.attempt || run.status !== 'in_progress' || run.head_sha !== identity.workflowSha ||
      run.event !== 'issues' || record(run.repository).id !== identity.repositoryId || !String(run.path).startsWith(names.workflowPath)) throw new GitHubError('ADMISSION_RUN');
    verified = true;
  }
  async function create(task: string, payload: Record<string, unknown>) {
    const response = await api.request('POST', `${base}/deployments`, {
      ref: identity.workflowSha, auto_merge: false, required_contexts: [], task, environment,
      transient_environment: true, production_environment: false, payload, description: names.ledgerDescription,
    });
    if (response.status !== 201) throw new GitHubError('ADMISSION_APPEND_UNCONFIRMED', response.status);
    const deployment = record(response.body);
    if (deployment.sha !== identity.workflowSha || canonicalJson(deployment.payload) !== canonicalJson(payload) ||
      record(deployment.creator).login !== 'github-actions[bot]') throw new GitHubError('ADMISSION_APPEND_MISMATCH');
    return positiveId(deployment.id);
  }
  /** Newest-first pages shift when records arrive during the read; a repeated record is skipped, a changed one refused. */
  async function list(task: string) {
    const entries = new Map<number, Record<string, unknown>>();
    for (let page = 1; page <= 100; page++) {
      const response = await api.request('GET', `${base}/deployments?environment=${environment}&task=${encodeURIComponent(task)}&per_page=100&page=${page}`);
      if (response.status !== 200 || !Array.isArray(response.body)) throw new GitHubError('ADMISSION_HISTORY', response.status);
      for (const entry of response.body) {
        const deployment = record(entry);
        const id = positiveId(deployment.id);
        if (deployment.environment !== environment || deployment.task !== task || record(deployment.creator).login !== 'github-actions[bot]') throw new GitHubError('ADMISSION_HISTORY_IDENTITY');
        const payload = record(deployment.payload);
        const previous = entries.get(id);
        if (previous && canonicalJson(previous) !== canonicalJson(payload)) throw new GitHubError('ADMISSION_HISTORY_IDENTITY');
        entries.set(id, payload);
      }
      if (response.body.length < 100) return entries;
    }
    throw new GitHubError('ADMISSION_HISTORY_LIMIT');
  }
  return {
    async append(reservation) {
      if (own !== undefined || reservation.runId !== String(identity.runId) || reservation.attempt !== identity.attempt) throw new GitHubError('ADMISSION_APPEND');
      await verifyRun();
      own = await create(reserve, { kind: names.reservationKind, schemaVersion: 1, reservation });
      return own;
    },
    async read() {
      await verifyRun();
      const outcomes = new Map<number, boolean>();
      for (const payload of (await list(decide)).values()) {
        if (payload.kind !== names.decisionKind || payload.schemaVersion !== 1 || typeof payload.admitted !== 'boolean') throw new GitHubError('ADMISSION_HISTORY_FORMAT');
        const position = positiveId(payload.position);
        // Only the first recorded outcome for a reservation counts.
        if (!outcomes.has(position)) outcomes.set(position, payload.admitted);
      }
      return [...(await list(reserve)).entries()].map(([position, payload]) => {
        if (payload.kind !== names.reservationKind || payload.schemaVersion !== 1) throw new GitHubError('ADMISSION_HISTORY_FORMAT');
        const admitted = outcomes.get(position);
        return { position, reservation: record(payload.reservation) as unknown as Reservation, ...(admitted === undefined ? {} : { admitted }) };
      });
    },
    async settle(position, admitted) {
      if (own === undefined || position !== own || settled) throw new GitHubError('ADMISSION_SETTLE');
      settled = true;
      await create(decide, { kind: names.decisionKind, schemaVersion: 1, position, admitted });
    },
  };
}
