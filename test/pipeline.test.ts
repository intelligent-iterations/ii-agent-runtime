import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPipeline, UnsupportedPipelineTarget, type Intake, type PipelineEvent, type PipelineTrigger } from '../src/pipeline/index.js';
import { compileConfiguration } from '../src/runtime/configuration.js';
import type { GitHubApi } from '../src/providers/github-http.js';
import { fixture, issueOptions } from './runtime-fixture.js';

const identity = { repository: 'example/control', workflowSha: 'a'.repeat(40), repositoryId: 1, runId: 2, attempt: 1 };
const trigger: PipelineTrigger = { kind: 'github-issue', api: { requests: 0, request: async () => { throw Error('unused'); } } as GitHubApi, run: identity, event: {},
  current: compileConfiguration(fixture()), readRequest: () => ({ repository: undefined, base: undefined }), options: issueOptions };
const options = { trigger, consumer: { name: 'sample-app', displayName: 'Sample App' }, secrets: { codeHostKey: 'synthetic-pem', modelKey: 'synthetic-model-key' }, host: { workParent: '/nonexistent', executablePath: '/usr/bin' } };

test('the pipeline is chosen by configuration and fails closed on a target, source, harness or trigger it has no adapter for', () => {
  const config = fixture();
  assert.doesNotThrow(() => createPipeline(compileConfiguration(config), options));
  // The schema admits only known values, so an unknown one can only arrive by bypassing it; the composition root still refuses.
  const compiled = compileConfiguration(config);
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
