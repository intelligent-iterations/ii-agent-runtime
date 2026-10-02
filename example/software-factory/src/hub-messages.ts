import type { CompiledConfiguration } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { CURRENT_LAYOUT, PRODUCT_NAME } from './identity.js';

/** What the hub says on an issue. Every refusal names what to do next; `policyPath` is the hub's policy file. */
export function explainRefusal(reason: string, target: string, config: CompiledConfiguration['configuration'], policyPath = CURRENT_LAYOUT.policyPath): string {
  const policy = config.launchPolicy;
  const access = policy.mode === 'any-author' ? 'read' : policy.minimumPermission;
  const label = policy.mode === 'maintainer-approval' ? policy.label : 'agent:run';
  const limits = config.limits;
  // Approval mode is retried by the approver; the author's reopen never starts an agent there.
  const retry = policy.mode === 'maintainer-approval' ? `Remove and re-add the \`${label}\` label` : 'Close and reopen this issue';
  const messages: Record<string, string> = {
    'approval-required': `Waiting for someone with ${access} access to \`${target}\` to add the \`${label}\` label.`,
    'approver-denied': `The \`${label}\` label only starts an agent when it is added by someone with ${access} access to \`${target}\`.`,
    'author-denied': `You need ${access} access to \`${target}\` to start an agent there.`,
    'author-event-required': 'Only the issue author can start this agent, by opening (or closing and reopening) the issue.',
    'public-submission-required': 'Only the issue author can start this agent, by opening (or closing and reopening) the issue.',
    'input-changed': `The issue changed while it was being checked. ${retry} to try again.`,
    'policy-changed': `The ${PRODUCT_NAME} policy changed while this issue was being checked. ${retry} to try again.`,
    'subject-closed': 'The issue is closed.',
    'evidence-stale': `Checking this issue took too long. ${retry} to try again.`,
    duplicate: `An agent already ran, or is running, for this exact task. Edit the task, then ${retry.toLowerCase()} to run it again.`,
    'subject-limit': `This issue already used its ${limits.maxRunsPerSubject} agent ${limits.maxRunsPerSubject === 1 ? 'run' : 'runs'}. Open a new issue for more work.`,
    'concurrency-limit': `${limits.maxConcurrent} ${limits.maxConcurrent === 1 ? 'agent is' : 'agents are'} already running for this organization. ${retry} in a few minutes to try again.`,
    'monthly-run-limit': `This organization used its ${limits.maxRunsPerMonth} agent runs for this month. An owner can raise \`limits.maxRunsPerMonth\` in \`${policyPath}\`.`,
    'monthly-cost-limit': `This run would exceed the organization's monthly budget of $${(limits.maxCostMicrousdPerMonth / 1e6).toFixed(2)}. An owner can raise \`limits.maxCostMicrousdPerMonth\` in \`${policyPath}\`.`,
    disabled: `${PRODUCT_NAME} is paused: \`limits.enabled\` is \`false\` in \`${policyPath}\`.`,
  };
  return messages[reason] ?? `The agent was not started (${reason}).`;
}

export function missingTargetMessage(organization: string): string {
  return `Name the repository to change: use the **Agent task** form, whose **Repository** field takes a ${organization} repository name.`;
}
export function notInstalledMessage(target: string, organization: string): string {
  return `The ${PRODUCT_NAME} App cannot access \`${target}\`. An owner can add it at https://github.com/organizations/${organization}/settings/installations, then close and reopen this issue.`;
}
export function missingBaseMessage(base: string, target: string): string {
  return `\`${target}\` has no branch named \`${base}\`, so there is nothing to open a pull request against. Fix the **Pull request into** field (or leave it empty for the default branch), then close and reopen this issue.`;
}
/** The agent's own account, quoted: its last message (shortened) and which programs failed. Never command arguments or output. */
export function activityNote(report: Record<string, unknown>, collapsed: boolean): string {
  const activity = (report.worker as { activity?: { commands: number; failed: Array<{ program: string; exitCode: number }>; lastMessage: string; errors: string[] } } | undefined)?.activity;
  if (!activity) return '';
  const setup = report.setup as { label?: string; exitCode?: number; seconds?: number; timedOut?: boolean } | undefined;
  const installed = !setup?.label ? [] : [setup.exitCode === 0 ? `Installed dependencies with \`${setup.label}\` (${setup.seconds} s) before the agent started.`
    : `Installing dependencies with \`${setup.label}\` ${setup.timedOut ? 'timed out' : `failed (exit ${setup.exitCode})`}; the agent worked without them.`];
  const said = activity.lastMessage.trim().slice(0, 600).replace(/\r?\n/g, '\n> ');
  const failed = activity.failed.map(entry => `\`${entry.program}\` (${entry.exitCode === 127 ? 'exit 127, a command was not found' : `exit ${entry.exitCode}`})`);
  const lines = [
    ...installed,
    `Ran ${activity.commands} ${activity.commands === 1 ? 'command' : 'commands'}${failed.length ? `; failed: ${[...new Set(failed)].join(', ')}` : ''}.`,
    ...(activity.errors.length ? [`Errors: ${activity.errors.map(error => error.slice(0, 200)).join('; ')}`] : []),
    ...(said ? ['', `> ${said}${activity.lastMessage.length > 600 ? ' ...' : ''}`] : []),
  ].join('\n');
  return collapsed ? `\n\n<details><summary>What the agent did</summary>\n\n${lines}\n</details>` : `\n\n**What the agent did:** ${lines}`;
}

const refusal = (value: unknown) => {
  const { status, reason } = (value ?? {}) as { status?: unknown; reason?: unknown };
  return Number.isSafeInteger(status) ? ` (HTTP ${status}${typeof reason === 'string' && reason ? `: ${reason}` : ''})` : '';
};
export function finishedMessage(target: string, report: Record<string, unknown>, runUrl: string, policyPath = CURRENT_LAYOUT.policyPath,
  organization = target.split('/')[0]): string {
  const push = report.push as { verified?: boolean; branch?: string; base?: string; commits?: number; files?: number } | undefined;
  const pull = report.changeRequest as { number?: number; url?: string } | undefined;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (push?.verified && push.commits && push.branch) {
    const work = `${plural(push.commits, 'commit')} changing ${plural(push.files ?? 0, 'file')}`;
    if (pull?.url) return `The agent opened [pull request #${pull.number}](${pull.url}) into \`${push.base}\` in \`${target}\`: ${work}. [Run details](${runUrl})${activityNote(report, true)}`;
    const why = report.changeRequestError === 'permission'
      ? ` ${PRODUCT_NAME} could not open it itself because its App lacks the **Pull requests** permission; an owner can add Read and write under the App's permissions in https://github.com/organizations/${organization}/settings/apps and accept the change.`
      : report.changeRequestError === 'refused' ? ` GitHub refused to open it automatically${refusal(report.changeRequestRefusal)}.` : '';
    return `The agent pushed ${work} to [\`${push.branch}\`](https://github.com/${target}/tree/${push.branch}) in \`${target}\`. ` +
      `[Open the pull request into \`${push.base}\`](https://github.com/${target}/compare/${push.base}...${push.branch}?expand=1).${why} [Run details](${runUrl})${activityNote(report, true)}`;
  }
  if (push?.verified && report.status === 'worker-completed') {
    return `The agent finished without pushing any changes to \`${target}\`, so there is no pull request. It may not have found what to change: name the files or behavior involved, ` +
      `or use a stronger model (\`harness.model\` in \`${policyPath}\`). Edit the task, then close and reopen this issue to try again. [Run details](${runUrl})${activityNote(report, false)}`;
  }
  if (report.status === 'worker-completed') return `The agent finished, but what it pushed could not be checked on GitHub. [Run details](${runUrl})`;
  return `The agent run did not complete (${String(report.status)}). [Run details](${runUrl})`;
}
export function checkFailedMessage(runUrl: string): string {
  return `The request could not be checked because of an error, so no agent started. [Run details](${runUrl})`;
}
