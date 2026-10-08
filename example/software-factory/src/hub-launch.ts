import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGitHubApi, getRecord, record, type ActionsIdentity, type GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { saveConfigurationArtifact } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { createPipeline, type PipelineServices } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { HUB_ARTIFACT_FOLDER, HUB_LAYOUT_VARIABLE, validateHubManifest } from './hub-files.js';
import { compileHubPolicy, hubLaunchSettings } from './hub-policy.js';
import { checkFailedMessage, explainRefusal, finishedMessage, missingBaseMessage, missingTargetMessage, notInstalledMessage } from './hub-messages.js';
import { hubRequestReader, parseTargetRepository } from './hub-issue-form.js';
import { hubLayout, PRODUCT_NAME } from './identity.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
}
function positive(value: string): number {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) throw Error('Invalid Actions identity');
  return number;
}
export function hubLaunchIdentity(env: NodeJS.ProcessEnv): ActionsIdentity {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Linux' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_EVENT_NAME !== 'issues' ||
    env.GITHUB_SERVER_URL !== 'https://github.com' || env.GITHUB_API_URL !== 'https://api.github.com') throw Error(`Hub launch requires the ${PRODUCT_NAME} hub workflow on a GitHub-hosted runner`);
  const repository = required(env, 'GITHUB_REPOSITORY').toLowerCase();
  const workflowSha = required(env, 'GITHUB_WORKFLOW_SHA');
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(workflowSha)) throw Error('Invalid hub identity');
  return { repository, workflowSha, repositoryId: positive(required(env, 'GITHUB_REPOSITORY_ID')),
    runId: positive(required(env, 'GITHUB_RUN_ID')), attempt: positive(required(env, 'GITHUB_RUN_ATTEMPT')) };
}
async function hubFile(api: GitHubApi, repository: string, path: string, revision: string): Promise<string> {
  const file = await getRecord(api, `/repos/${repository}/contents/${path}?ref=${revision}`);
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 200000) throw Error('Invalid hub file');
  return Buffer.from(file.content, 'base64').toString('utf8');
}
function readEvent(path: string): Record<string, unknown> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1048576) throw Error('Invalid Actions event');
    return record(JSON.parse(readFileSync(descriptor, 'utf8')));
  } finally { closeSync(descriptor); }
}

/**
 * Runs in the hub's trusted job for one hub issue event. It reads the hub's own files, hands the run to the runtime
 * pipeline (which holds the keys and runs every stage), and explains each outcome on the issue.
 */
export async function launchFromHub(env: NodeJS.ProcessEnv = process.env, services: Partial<PipelineServices> = {}): Promise<void> {
  const hub = hubLaunchIdentity(env);
  // The layout the hub's workflow was generated for names its folder, its ledger and its branches; an unknown one stops here.
  const layout = hubLayout(required(env, HUB_LAYOUT_VARIABLE));
  const githubToken = required(env, 'FACTORY_GITHUB_TOKEN');
  const codeHostKey = required(env, 'FACTORY_APP_PRIVATE_KEY');
  const modelKey = required(env, 'FACTORY_CODEX_API_KEY');
  delete env.FACTORY_APP_PRIVATE_KEY; delete env.FACTORY_CODEX_API_KEY; delete env.FACTORY_GITHUB_TOKEN;
  const api = (services.createGitHubApi ?? createGitHubApi)({ credential: () => githubToken, maxRequests: 200 });
  const event = readEvent(required(env, 'GITHUB_EVENT_PATH'));
  const issueNumber = Number(record(event.issue).number);
  const runUrl = `https://github.com/${hub.repository}/actions/runs/${hub.runId}`;
  const comment = async (body: string) => {
    // Comments are best-effort feedback; they never decide or block a launch.
    await api.request('POST', `/repos/${hub.repository}/issues/${issueNumber}/comments`, { body }).catch(() => undefined);
  };
  const manifest = validateHubManifest(JSON.parse(await hubFile(api, hub.repository, layout.manifestPath, hub.workflowSha)), layout);
  if (manifest.hub.repository !== hub.repository || manifest.hub.id !== hub.repositoryId) throw Error('Hub identity mismatch');
  const target = parseTargetRepository(record(event.issue).body, manifest.organization);
  if (!target || target === hub.repository) {
    if (event.action !== 'labeled') await comment(missingTargetMessage(manifest.organization));
    return;
  }
  const policy = await hubFile(api, hub.repository, layout.policyPath, hub.workflowSha);
  const compiled = compileHubPolicy(policy, manifest, target);
  const config = compiled.configuration;
  const settings = hubLaunchSettings(policy);
  // Labels unrelated to approval are ordinary triage; they neither start agents nor get a reply.
  if (event.action === 'labeled' && (config.launchPolicy.mode !== 'maintainer-approval' || record(event.label).name !== config.launchPolicy.label)) return;
  const head = await getRecord(api, `/repos/${hub.repository}/commits/${encodeURIComponent(manifest.hub.branch)}`);
  if (!/^[a-f0-9]{40}$/.test(String(head.sha))) throw Error('Invalid hub revision');
  const current = compileHubPolicy(await hubFile(api, hub.repository, layout.policyPath, String(head.sha)), manifest, target);
  if (settings.evidence.maxBytes < Buffer.byteLength(compiled.canonical) + 32768) throw Error('Artifact budget must include 32 KiB for run evidence');
  const parent = resolve(required(env, 'FACTORY_ARTIFACT_PARENT'));
  const runnerTemp = realpathSync(required(env, 'RUNNER_TEMP'));
  if (parent !== join(runnerTemp, HUB_ARTIFACT_FOLDER)) throw Error('Invalid artifact parent');
  mkdirSync(parent, { mode: 0o700 });
  const artifact = saveConfigurationArtifact(parent, config);
  const pipeline = createPipeline(compiled, {
    trigger: { kind: 'github-issue', api, run: hub, event, current, readRequest: hubRequestReader(manifest.organization), options: settings.trigger },
    consumer: layout.identity,
    secrets: { codeHostKey, modelKey }, host: { workParent: runnerTemp, executablePath: required(env, 'PATH'),
      ...(config.environment.provider === 'openshell' && env.FACTORY_WORKER_GATEWAY_ADDRESS
        ? { openshell: { gatewayAddress: env.FACTORY_WORKER_GATEWAY_ADDRESS } } : {}) }, services,
  });
  const { report, started, failed } = await pipeline.run({
    report: { hub: hub.repository, issue: issueNumber },
    async onEvent(event) {
      if (event.type === 'target-unreachable') await comment(notInstalledMessage(target, manifest.organization));
      else if (event.type === 'missing-base') await comment(missingBaseMessage(event.base, target));
      else if (event.type === 'denied') await comment(explainRefusal(event.reason, target, event.stage === 'authorization' ? current.configuration : config, layout.policyPath));
      else await comment(`Starting an agent on \`${target}\`. [Follow the run](${runUrl})`);
    },
    describeChange: task => ({ title: task.title.replace(/^\[agent\]\s*/i, '') || `${PRODUCT_NAME} task #${issueNumber}`,
      body: `Opened by ${PRODUCT_NAME} for [${hub.repository}#${issueNumber}](https://github.com/${hub.repository}/issues/${issueNumber}). ` +
        `Review it like any other change before merging. [Agent run](${runUrl})` }),
  });
  if (started) await comment(finishedMessage(target, report, runUrl, layout.policyPath));
  else if (report.status !== 'denied') await comment(checkFailedMessage(runUrl));
  writeFileSync(join(artifact, 'run.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const size = readdirSync(artifact).reduce((sum, name) => sum + statSync(join(artifact, name)).size, 0);
  if (size > settings.evidence.maxBytes) throw Error('Run evidence exceeds artifact budget');
  const output = required(env, 'GITHUB_OUTPUT');
  if (/[\r\n]/.test(artifact)) throw Error('Unsafe artifact output');
  writeFileSync(output, `artifact_directory=${artifact}\n`, { flag: 'a' });
  if (failed) throw Error('Agent launch failed; inspect the bounded run evidence.');
}
