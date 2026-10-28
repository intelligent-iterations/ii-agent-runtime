import { UnsupportedPipelineTarget, type Intake, type PipelineEvent } from '../src/ports.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPipeline, type PipelineTrigger } from '../src/create-pipeline.js';
import { compileConfiguration } from '../src/configuration.js';
import type { GitHubApi } from '@intelligent-iterations/ii-agent-runtime/github';
import { fixture, issueOptions } from './pipeline-fixture.js';

const identity = { repository: 'example/control', workflowSha: 'a'.repeat(40), repositoryId: 1, runId: 2, attempt: 1 };
const trigger: PipelineTrigger = { kind: 'github-issue', api: { requests: 0, request: async () => { throw Error('unused'); } } as GitHubApi, run: identity, event: {},
  current: compileConfiguration(fixture()), readRequest: () => ({ repository: undefined, base: undefined }), options: issueOptions };
const unboundOptions = { trigger, consumer: { name: 'sample-app', displayName: 'Sample App' }, secrets: { codeHostKey: 'synthetic-pem', modelKey: 'synthetic-model-key' }, host: { workParent: '/nonexistent', executablePath: '/usr/bin' } };
const options = { ...unboundOptions, executionTarget: { provision: async () => { throw Error('Unused explicit target'); }, close: async () => {} } };

test('GitHub selection never infers execution from control-process tools or isolation choice', () => {
  for (const provider of ['docker', 'openshell'] as const) {
    const config = fixture(); config.environment.provider = provider;
    for (const workParent of ['/control/machine-a', '/control/machine-b']) {
      assert.throws(() => createPipeline(compileConfiguration(config), { ...unboundOptions,
        host: { workParent, executablePath: '/control/bin' } }),
      (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'executionTarget');
    }
  }
});

test('an explicit execution binding cannot replace a configured cloud deployment', () => {
  const config = fixture(); const aws = { infrastructure: { ami: 'ami-0123456789abcdef0', instance_type: 't3.medium', subnet_id: 'subnet-0123456789abcdef0', vpc_security_group_ids: ['sg-0123456789abcdef0'], key_name: 'operator' }, providerConfiguration: { region: 'us-east-1' } };
  config.environment.hosting = { provider: 'aws', infrastructure: aws.infrastructure, providerConfiguration: aws.providerConfiguration,
    executorImage: 'example/executor@sha256:' + 'a'.repeat(64), ssh: { user: 'operator', identityFile: '/private/key', knownHostsFile: '/private/hosts' } };
  const compiled = compileConfiguration(config);
  assert.throws(() => createPipeline(compiled, options), (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'executionTarget');
  assert.doesNotThrow(() => createPipeline(compiled, unboundOptions));
});

test('the pipeline provisions and cleans only the supplied execution target', async () => {
  const compiled = compileConfiguration(fixture());
  const calls: string[] = [];
  const task = { reference: 'request-1', label: 'Request 1', title: 'Test', body: 'Test' };
  const intake: Intake = {
    runId: 'run-1', attempt: 1, resource: 'test',
    authorize: async () => ({ allowed: true, reason: 'authorized', decision: {}, subjectId: 'request-1', inputDigest: 'sha256:' + 'a'.repeat(64), task }),
    confirm: async first => first,
    admit: async () => ({ allowed: true, reservationDigest: 'sha256:' + 'b'.repeat(64), reservation: { schemaVersion: 1,
      resource: 'test', subjectId: 'request-1', runId: 'run-1', attempt: 1, inputDigest: 'sha256:' + 'a'.repeat(64), policyDigest: compiled.setupDigest,
      createdAt: Date.now(), expiresAt: Date.now() + 60000, reservedMicrousd: 1 } }),
  };
  const outcome = await createPipeline(compiled, { ...options, trigger: { kind: 'custom', intake },
    host: { workParent: '/control/not-an-agent-host', executablePath: '/control/no-agent-tools' },
    executionTarget: { provision: async () => { calls.push('selected-target'); throw Error('Stop before checkout'); }, close: async () => { calls.push('selected-target-cleanup'); } },
    services: { openTofuWorker: () => { calls.push('incorrect-local-execution'); throw Error('Must not choose local compute'); } },
  }).run();
  assert.equal(outcome.started, true);
  assert.equal(outcome.report.phase, 'provisioning');
  assert.deepEqual(calls, ['selected-target', 'selected-target-cleanup']);
  assert.ok(outcome.report.cleanup && (outcome.report.cleanup as Array<{ component: string; confirmed: boolean }>).some(entry => entry.component === 'provisioner' && entry.confirmed));
});

test('the pipeline is chosen by configuration and fails closed on a target, source, harness or trigger it has no adapter for', () => {
  const config = fixture();
  assert.doesNotThrow(() => createPipeline(compileConfiguration(config), options));
  // The schema admits only known values, so an unknown one can only arrive by bypassing it; the composition root still refuses.
  const compiled = compileConfiguration(config);
  const withoutHosting = { ...compiled, configuration: { ...compiled.configuration, environment: { ...compiled.configuration.environment, hosting: undefined as never } } };
  assert.throws(() => createPipeline(withoutHosting, options), (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'environment.hosting');
  const withTarget = { ...compiled, configuration: { ...compiled.configuration, environment: { ...compiled.configuration.environment, provider: 'aws' as never } } };
  assert.throws(() => createPipeline(withTarget, options), (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'environment.provider');
  const withSource = { ...compiled, configuration: { ...compiled.configuration, source: { ...compiled.configuration.source, provider: 'gitlab' as never } } };
  assert.throws(() => createPipeline(withSource, options), (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'source.provider');
  const withHarness = { ...compiled, configuration: { ...compiled.configuration, harness: { ...compiled.configuration.harness, name: 'other' as never } } };
  assert.throws(() => createPipeline(withHarness, options), (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'harness.name');
  assert.throws(() => createPipeline(compiled, { ...options, trigger: { ...trigger, kind: 'email' } as never }),
    (error: unknown) => error instanceof UnsupportedPipelineTarget && error.setting === 'trigger.kind');
  assert.throws(() => createPipeline(compiled, { ...options, consumer: { name: 'Bad Name', displayName: 'x' } }), /Invalid consumer name/);
});

test('a pipeline runs once', async () => {
  const pipeline = createPipeline(compileConfiguration(fixture()), { ...options, services: {
    authorizeIssueTask: async () => { throw Error('Synthetic stop'); } } });
  await pipeline.run();
  await assert.rejects(pipeline.run(), /runs once/);
});

test('a consumer brings its own intake, and the pipeline runs it like a built-in one', async () => {
  const calls: string[] = [];
  const task = { reference: 'chat-42', label: 'Request 42', title: 'Fix the sample', body: 'From a chat message' };
  const intake: Intake = {
    runId: 'chat-run-7', attempt: 1, resource: 'chat:workspace',
    authorize: async () => { calls.push('authorize'); return { allowed: true, reason: 'authorized', decision: {}, subjectId: 'chat:42', inputDigest: 'sha256:x', task }; },
    confirm: async first => first,
    admit: async () => { calls.push('admit'); return { allowed: false, reason: 'concurrency-limit' }; },
  };
  const events: PipelineEvent[] = [];
  const outcome = await createPipeline(compileConfiguration(fixture()), { ...options, trigger: { kind: 'custom', intake } })
    .run({ onEvent: async event => { events.push(event); } });
  assert.deepEqual(calls, ['authorize', 'admit']);
  assert.deepEqual(events, [{ type: 'denied', reason: 'concurrency-limit', stage: 'admission' }]);
  assert.deepEqual([outcome.started, outcome.failed, outcome.report.status, outcome.report.runId, outcome.report.repository, outcome.report.billingMode],
    [false, false, 'denied', 'chat-run-7', 'example/project', 'none']);
  assert.deepEqual(outcome.report.cleanup, [{ component: 'github-tokens', confirmed: true }]);
});
