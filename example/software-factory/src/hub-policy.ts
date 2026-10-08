import { compileConfiguration, type CompiledConfiguration } from '@intelligent-iterations/ii-agent-runtime/runtime';
import type { IssueTriggerOptions } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import type { HubManifest } from './hub-files.js';
import { HUB_JOB_OVERHEAD_MINUTES } from './identity.js';

/**
 * The hub policy (`policy.json` in the hub's configuration folder, see identity.ts) is the Factory's own file, in the
 * Factory's own format: one policy for the whole organization, without a target. At launch it is compiled into the
 * runtime's configuration for the repository an issue names. Settings only the hub uses (its workflow's start limits, retained evidence, the worker
 * image's signer) stay here and never reach the runtime.
 */

/** A note at the top of the policy file. Keys starting with "_" are notes and are removed before compiling. */
export const POLICY_README = 'To change the model, set harness.model (for example gpt-6-luna) and set limits.inputMicrousdPerMillionTokens and ' +
  'limits.outputMicrousdPerMillionTokens to its price per 1M tokens in millionths of a dollar (gpt-6-astra: 10000000 and 50000000). ' +
  'Budgets are in millionths of a dollar too. Rerun example/software-factory/onboard.sh to change limits interactively. ' +
  'To run the worker from your own registry, set environment.image to your copy, pinned by digest. To require a signed build, set ' +
  'imageVerification.signerRepository to the repository whose workflow attested the image. Rerun example/software-factory/onboard.sh after changing either, ' +
  'so the hub workflow pulls and verifies the new image. Dependencies are installed before the agent starts, from the repository\'s ' +
  'lockfile; set environment.setup to {"enabled": false} to turn that off, or give environment.setup.commands to replace it.';

/** What every hub agent is told, after the organization's instructions: the hub opens the pull request, not the agent. */
export const FACTORY_AGENT_NOTE = 'Software Factory opens the pull request for your pushed task branch and replies on the hub issue. ' +
  'Do not open pull requests or create issues yourself.';

// Every setting a policy may hold. Anything else is a typo or a setting from another tool, and is refused rather than ignored.
const SETTINGS: Record<string, string[] | null> = {
  schemaVersion: null, id: null, revision: null, instructions: null, launchPolicy: null,
  harness: ['name', 'version', 'model', 'apiKeySecret'],
  environment: ['provider', 'runner', 'image', 'cpu', 'memoryMiB', 'setup'],
  github: ['additionalRepositories'],
  limits: ['enabled', 'maxConcurrent', 'maxRunsPerIssue', 'maxRunsPerMonth', 'maxWorkflowRunNumber', 'maxWorkflowAttempts', 'timeoutMinutes',
    'maxModelRequests', 'maxInputTokensPerRequest', 'maxOutputTokensPerRequest', 'maxModelCostMicrousdPerRun', 'maxCostMicrousdPerMonth',
    'inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens', 'runnerMicrousdPerMinute'],
  artifacts: ['provider', 'retentionDays', 'maxBytes'],
  imageVerification: ['signerRepository'],
};

/** Reads a policy file: notes removed, every setting known. */
export function readHubPolicy(policy: string): Record<string, any> {
  const data = JSON.parse(policy) as Record<string, any>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid hub policy');
  for (const key of Object.keys(data)) {
    if (key.startsWith('_')) { delete data[key]; continue; }
    if (!(key in SETTINGS)) throw Error(`Unknown hub policy setting: ${key}`);
    const allowed = SETTINGS[key];
    if (allowed && (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key]))) throw Error(`Hub policy setting ${key} must be an object`);
    for (const inner of allowed ? Object.keys(data[key]) : []) if (!allowed?.includes(inner)) throw Error(`Unknown hub policy setting: ${key}.${inner}`);
  }
  // Older policies name where the hub runs; it always runs on its GitHub-hosted runner, so only that is accepted.
  if (data.environment?.provider !== undefined && !['github-actions', 'docker', 'openshell'].includes(data.environment.provider)) throw Error('environment.provider must be docker, openshell, or legacy github-actions (or omitted)');
  if (data.environment?.runner !== undefined && data.environment.runner !== 'ubuntu-latest') throw Error('environment.runner must be ubuntu-latest (or omitted)');
  if (data.artifacts?.provider !== undefined && data.artifacts.provider !== 'github-actions') throw Error('artifacts.provider must be github-actions (or omitted)');
  return data;
}

/** Hub-only settings kept in the policy file; they shape the hub workflow and are removed before compiling the agent policy. */
export interface HubImageSettings { image: string; signerRepository?: string }
export function hubImageSettings(policy: Record<string, any>): HubImageSettings {
  const signer = policy.imageVerification?.signerRepository;
  if (signer !== undefined && signer !== '' && (typeof signer !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(signer))) throw Error('imageVerification.signerRepository must be OWNER/REPOSITORY');
  return { image: String(policy.environment?.image ?? ''), ...(signer ? { signerRepository: signer } : {}) };
}

const whole = (value: unknown, minimum: number, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  return value as number;
};
/** How the hub workflow runs: how many issue events may start a job, and what evidence each job keeps. */
export interface HubLaunchSettings { trigger: IssueTriggerOptions; evidence: { retentionDays: number; maxBytes: number } }
export function hubLaunchSettings(policy: string): HubLaunchSettings {
  const data = readHubPolicy(policy);
  return {
    // Hub issues are opened, or closed and reopened to retry; a label approves. Anything else is not a request.
    trigger: { startLimits: { maxRunNumber: whole(data.limits?.maxWorkflowRunNumber, 1, 100000, 'limits.maxWorkflowRunNumber'),
      maxAttempts: whole(data.limits?.maxWorkflowAttempts, 1, 3, 'limits.maxWorkflowAttempts') } },
    evidence: { retentionDays: whole(data.artifacts?.retentionDays ?? 7, 1, 30, 'artifacts.retentionDays'),
      maxBytes: whole(data.artifacts?.maxBytes ?? 1048576, 1024, 10485760, 'artifacts.maxBytes') },
  };
}

/** Writes a policy file from the Factory's defaults, so users edit only what they own. */
export function hubPolicy(defaults: Record<string, unknown>): string {
  const data = { _readme: POLICY_README, ...structuredClone(defaults) } as Record<string, any>;
  data.github = { additionalRepositories: data.github?.additionalRepositories ?? [] };
  if (data.harness) delete data.harness.apiKeySecret;
  // Limits cover the whole organization, and every hub issue event counts toward the run-number cap.
  data.limits = { ...(data.limits ?? {}), maxConcurrent: Math.max(3, data.limits?.maxConcurrent ?? 1),
    maxWorkflowRunNumber: Math.max(DEFAULT_HUB_RUN_LIMIT, data.limits?.maxWorkflowRunNumber ?? 0) };
  return JSON.stringify(data, null, 2) + '\n';
}
/** Hub runs that can start before any admission check; each costs at least one billed runner minute. */
export const DEFAULT_HUB_RUN_LIMIT = 10000;

/** Compiles the organization's policy into the runtime configuration for one issue's target repository. */
export function compileHubPolicy(policy: string, manifest: HubManifest, target: string): CompiledConfiguration {
  const data = readHubPolicy(policy);
  hubImageSettings(data);
  hubLaunchSettings(policy);
  // Anyone who can read the hub can file an issue, so the requester must already be able to change the target, and
  // no request may reach a repository beyond the one it names.
  const launch = data.launchPolicy ?? {};
  if (!['authorized-author', 'maintainer-approval'].includes(launch.mode) || !['write', 'maintain', 'admin'].includes(launch.minimumPermission)) {
    throw Error('A hub policy must require write access or higher to the named repository (authorized-author or maintainer-approval)');
  }
  if ((data.github?.additionalRepositories ?? []).length) throw Error('A hub policy cannot grant additional repositories');
  const { name, version, model } = data.harness ?? {};
  const { image, cpu, memoryMiB, setup } = data.environment ?? {};
  const limits = data.limits ?? {};
  // A missing setting is left out, not set to undefined, so the runtime names it as missing.
  return compileConfiguration(JSON.parse(JSON.stringify({
    schemaVersion: 2, id: data.id, revision: data.revision,
    instructions: typeof data.instructions === 'string' ? `${data.instructions}\n\n${FACTORY_AGENT_NOTE}` : data.instructions,
    harness: { name, version, model },
    // The hub job runs the agent in a container on its own runner.
    environment: { provider: data.environment?.provider === 'openshell' ? 'openshell' : 'docker', image, cpu, memoryMiB, ...(setup === undefined ? {} : { setup }) },
    // The agent may push its task branch; the hub opens the pull request and replies with its own tokens.
    source: { provider: 'github', repository: target, appId: manifest.app.id, installationId: manifest.app.installationId,
      permissions: { contents: 'write' }, requireAppOwner: true, additionalRepositories: [] },
    launchPolicy: launch,
    limits: { enabled: limits.enabled, maxConcurrent: limits.maxConcurrent, maxRunsPerSubject: limits.maxRunsPerIssue, maxRunsPerMonth: limits.maxRunsPerMonth,
      timeoutMinutes: limits.timeoutMinutes, overheadMinutes: HUB_JOB_OVERHEAD_MINUTES, maxModelRequests: limits.maxModelRequests,
      maxInputTokensPerRequest: limits.maxInputTokensPerRequest, maxOutputTokensPerRequest: limits.maxOutputTokensPerRequest,
      maxModelCostMicrousdPerRun: limits.maxModelCostMicrousdPerRun, maxCostMicrousdPerMonth: limits.maxCostMicrousdPerMonth,
      inputMicrousdPerMillionTokens: limits.inputMicrousdPerMillionTokens, outputMicrousdPerMillionTokens: limits.outputMicrousdPerMillionTokens,
      computeMicrousdPerMinute: limits.runnerMicrousdPerMinute },
  })));
}
