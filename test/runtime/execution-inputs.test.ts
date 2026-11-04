import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileExecutionInputs, createExecutionInputRecord, type ExecutionInputs } from '../../src/runtime/execution-inputs.js';
import { inputs } from '../execution-input-fixture.js';

test('input identity changes for every resolved input category; execution and revision labels remain separate', () => {
  const initial = inputs();
  const compiled = compileExecutionInputs(initial);
  const changes: Array<(input: ExecutionInputs) => void> = [
    value => { value.prompt = { kind: 'inline', text: 'A different final prompt' }; },
    value => { value.repositories[0]!.commit = 'c'.repeat(40); },
    value => { value.repositories[0]!.localChanges = { reference: 'store:patch', digest: `sha256:${'c'.repeat(64)}`, bytes: 10 }; },
    value => { value.artifacts[0]!.artifact.digest = `sha256:${'c'.repeat(64)}`; },
    value => { value.components[0]!.version = 'revision-2'; },
    value => { value.model.identity = 'sample-model-2'; },
    value => { value.model.parameters.temperature = 0.2; },
    value => { value.environment.LANG = 'en_US.UTF-8'; },
    value => { value.credentials[0]!.assignment = 'read-other-repository'; },
    value => { value.configuration.environment.cpu += 1; },
  ];
  for (const change of changes) {
    const changed = structuredClone(initial); change(changed);
    assert.notEqual(compileExecutionInputs(changed).inputDigest, compiled.inputDigest);
  }
  const first = createExecutionInputRecord(initial, { executionId: 'run-1', attemptId: '1' });
  const second = createExecutionInputRecord(initial, { executionId: 'run-2', attemptId: '2' });
  assert.equal(first.inputDigest, second.inputDigest);
  assert.notEqual(first.executionId, second.executionId);
  initial.configuration.revision = 'new-label';
  const relabeled = compileExecutionInputs(initial);
  assert.equal(relabeled.inputDigest, compiled.inputDigest);
  assert.notEqual(relabeled.artifactDigest, compiled.artifactDigest);
  initial.environment.LANG = 'changed';
  assert.equal(first.inputs.environment.LANG, 'C.UTF-8', 'the record snapshots caller data');
  assert.throws(() => compileExecutionInputs({ ...inputs(), executionId: 'run-1' }));
  assert.throws(() => compileExecutionInputs({ ...inputs(), elapsedSeconds: 30 }));
});

test('canonical input sets normalize ordering and reject duplicate identities', () => {
  const input = inputs();
  input.repositories.push({ repository: 'example/other', commit: 'b'.repeat(40), localChanges: null });
  input.components.push({ name: 'harness', version: '2' });
  const expected = compileExecutionInputs(input);
  input.repositories.reverse(); input.components.reverse();
  assert.deepEqual(compileExecutionInputs(Object.fromEntries(Object.entries(input).reverse())), expected);
  input.repositories.push({ ...input.repositories[0]!, commit: 'f'.repeat(40) });
  assert.throws(() => compileExecutionInputs(input), /EXECUTION_DUPLICATE/);
});

test('unknown prompt capture is explicit and cannot be mistaken for retained bytes', () => {
  const input = inputs();
  input.prompt = { kind: 'unavailable', reason: 'Caller did not capture the prompt' };
  assert.throws(() => compileExecutionInputs(input), /EXECUTION_COVERAGE/);
  input.coverage.push({ field: 'prompt', reason: 'Not captured' });
  const original = compileExecutionInputs(input);
  input.prompt = { kind: 'artifact', artifact: { reference: 'store:prompt', digest: `sha256:${'d'.repeat(64)}`, bytes: 42 } };
  assert.notEqual(compileExecutionInputs(input).inputDigest, original.inputDigest);
  assert.equal(original.inputs.prompt.kind, 'unavailable', 'late evidence cannot rewrite an existing snapshot');
});

test('credential values never enter output or digest when supplied to the in-memory exclusion boundary', () => {
  const secret = 'synthetic-secret-"with\\escapes';
  const placements: Array<(value: ExecutionInputs) => void> = [
    value => { value.prompt = { kind: 'inline', text: `prefix ${secret}` }; },
    value => { value.environment.AUTH = secret; },
    value => { value.model.parameters.authorization = secret; },
    value => { value.credentials[0]!.key = secret; },
    value => { value.artifacts[0]!.artifact.reference = `store:${secret}`; },
  ];
  for (const place of placements) {
    const value = inputs(); place(value);
    assert.throws(() => compileExecutionInputs(value, { secretValues: [secret] }), error =>
      error instanceof Error && error.message.includes('EXECUTION_SECRET') && !error.message.includes(secret));
  }
  assert.throws(() => compileExecutionInputs(inputs(), { secretValues: [''] }), /SECRET_FILTER/);
  const input = inputs();
  assert.throws(() => compileExecutionInputs({ ...input, credentials: [{ ...input.credentials[0], value: 'hidden' }] }));
  assert.throws(() => createExecutionInputRecord(input, { executionId: 'private-run', attemptId: '1' }, { secretValues: ['private-run'] }));
  assert.equal(compileExecutionInputs(input, { secretValues: ['rotation-one'] }).inputDigest,
    compileExecutionInputs(input, { secretValues: ['rotation-two'] }).inputDigest);
});

test('reject invalid revisions, executable input and oversized records before effects', () => {
  const value = inputs(); value.repositories[0]!.commit = 'main';
  assert.throws(() => compileExecutionInputs(value));
  let invoked = false;
  assert.throws(() => compileExecutionInputs({ get schemaVersion() { invoked = true; return 1; } }));
  assert.equal(invoked, false);
  assert.throws(() => compileExecutionInputs({ ...inputs(), prompt: { kind: 'inline', text: 'x'.repeat(1048577) } }));
  assert.throws(() => createExecutionInputRecord(inputs(), { executionId: '../run', attemptId: '1' }));
});
