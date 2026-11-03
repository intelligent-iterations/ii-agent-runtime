import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileConfiguration } from '../../src/runtime/configuration.js';
import { workerResources, validateWorkerResources } from '../../src/pipeline/worker-resources.js';
import { fixture } from '../runtime-fixture.js';

test('configured bounded run budgets reach the target unchanged, with a two-hour ceiling', () => {
  const config = fixture();
  for (const minutes of [60, 90, 120]) {
    config.limits.timeoutMinutes = minutes;
    const resources = workerResources(compileConfiguration(config));
    assert.equal(resources.timeoutSeconds, minutes * 60);
    assert.deepEqual(validateWorkerResources(resources), resources);
    assert.throws(() => validateWorkerResources({ ...resources, timeoutSeconds: 7201 }));
  }
  config.limits.timeoutMinutes = 121;
  assert.throws(() => compileConfiguration(config));
});
