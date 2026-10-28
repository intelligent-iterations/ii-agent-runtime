import { createExecutionTarget } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import type { CompiledConfiguration } from './configuration.js';
import type { GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import type { ActionsIdentity } from './github-authorization.js';
import type { IssueRequestReader, IssueTriggerOptions } from './github-issue.js';
import { consumerNames, type ConsumerIdentity } from './consumer.js';
import { githubIssueIntake, githubServices, githubSourceHost, type GitHubServices } from './github-pipeline.js';
import { codexHarness } from './codex-harness.js';
import { executeCodexWorker } from './codex-worker.js';
import { openaiModel } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { executionServices, type ExecutionServices } from '@intelligent-iterations/ii-agent-runtime/pipeline';
import { UnsupportedPipelineTarget, type ExecutionTarget, type Intake, type PipelineOutcome } from './ports.js';
import { runPipeline, type RunOptions } from './run.js';

/**
 * How the task arrived. A built-in intake adapter, chosen by `kind`, or the consumer's own `Intake` (a chat message, a
 * ticket, a command line), which the pipeline treats exactly like a built-in one.
 */
export type PipelineTrigger =
  | { kind: 'github-issue'; api: GitHubApi;
      /** The workflow run executing in the control repository, where the issue was filed. */
      run: ActionsIdentity; event: unknown;
      /** The policy on the control repository's default branch, compiled for the same target. */
      current: CompiledConfiguration;
      /** The consumer's issue form: which repository and base branch an issue body names. */
      readRequest: IssueRequestReader;
      options: IssueTriggerOptions }
  | { kind: 'custom'; intake: Intake };

export type PipelineServices = GitHubServices & ExecutionServices & { executeCodexWorker: typeof executeCodexWorker };

export interface PipelineOptions {
  trigger: PipelineTrigger;
  /** Who runs the pipeline: names its task branches, its commits, and any records an adapter keeps. */
  consumer: ConsumerIdentity;
  /** Held only inside the pipeline and dropped when it finishes: the source host's key and the model provider's key. */
  secrets: { codeHostKey: string; modelKey: string };
  /** Control-process tools, credentials and deployment records. These do not select the agent's machine. */
  host: { workParent: string; executablePath: string; cloudEnvironment?: Record<string, string> };
  /** Required for GitHub: an explicit connection to the selected execution environment. Never inferred from host. */
  executionTarget?: ExecutionTarget;
  /** Test seams for the adapters' provider calls. */
  services?: Partial<PipelineServices>;
}

export interface Pipeline { run(options?: RunOptions): Promise<PipelineOutcome> }

/**
 * Composes configured cloud adapters or an explicitly bound execution target. An unknown target, source, harness or
 * trigger fails closed with `UnsupportedPipelineTarget`; control-process location never selects agent placement.
 */
export function createPipeline(compiled: CompiledConfiguration, options: PipelineOptions): Pipeline {
  const config = compiled.configuration;
  const { launchPolicy: _launchPolicy, ...infrastructure } = config;
  const runtime = { ...compiled.runtime, configuration: infrastructure };
  const target = createExecutionTarget(runtime, options);
  const services: PipelineServices = { ...githubServices, ...executionServices, executeCodexWorker, ...options.services };
  if (!['docker', 'openshell'].includes(config.environment.provider)) throw new UnsupportedPipelineTarget('environment.provider', config.environment.provider);
  if (config.source.provider !== 'github') throw new UnsupportedPipelineTarget('source.provider', config.source.provider);
  if (config.harness.name !== 'codex') throw new UnsupportedPipelineTarget('harness.name', config.harness.name);
  consumerNames(options.consumer);
  const trigger = options.trigger;
  if (trigger.kind !== 'github-issue' && trigger.kind !== 'custom') throw new UnsupportedPipelineTarget('trigger.kind', (trigger as { kind: unknown }).kind);
  let used = false;
  return {
    async run(runOptions = {}) {
      if (used) throw Error('A pipeline runs once');
      used = true;
      let modelKey = options.secrets.modelKey;
      const source = githubSourceHost(compiled, { consumer: options.consumer, privateKey: options.secrets.codeHostKey,
        scratch: options.host.workParent, executablePath: options.host.executablePath, services });
      const intake = trigger.kind === 'custom' ? trigger.intake : githubIssueIntake(compiled, { api: trigger.api, run: trigger.run, event: trigger.event,
        current: trigger.current, source, consumer: options.consumer, readRequest: trigger.readRequest, trigger: trigger.options, services });
      return runPipeline(compiled, {
        intake, source, consumer: options.consumer,
        target,
        harness: codexHarness(compiled, { executablePath: options.host.executablePath, services }),
        model: openaiModel(compiled.runtime, { apiKey: () => modelKey, services }),
        gateway: input => services.openWorkerGateway({ ...input, deniedRequests: input.grants.flatMap(grant =>
          ['', '/'].map(suffix => ({ method: 'POST', path: `/github/${grant.repository}/issues${suffix}` }))) }),
        dispose: () => { modelKey = ''; },
      }, runOptions);
    },
  };
}
