import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelBudget } from '../src/runtime/model-budget.js';

const limits = { maxModelRequests: 10, maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 100,
  maxModelCostMicrousdPerRun: 600, inputMicrousdPerMillionTokens: 1000000, outputMicrousdPerMillionTokens: 2000000 };

test('actual input counts and capped output reserve worst-case charges before generation', () => {
  const budget = createModelBudget(limits);
  const first = budget.begin();
  assert.deepEqual(budget.reserve(first, 100, 10000), { maxOutputTokens: 100, reservedMicrousd: 300 });
  assert.throws(() => budget.reserve(first, 1, 1), /replayed/);
  const second = budget.begin();
  budget.reserve(second, 100, 100);
  assert.throws(() => budget.reserve(budget.begin(), 1, 1), /cost limit/);
  assert.equal(budget.snapshot().reservedMicrousd, 600);
});

test('failed preflights still consume attempts and rounded reservations cannot exceed the cap', () => {
  const budget = createModelBudget({ ...limits, maxModelRequests: 2, inputMicrousdPerMillionTokens: 1, outputMicrousdPerMillionTokens: 1 });
  const canceled = budget.begin();
  budget.cancelBeforeGeneration(canceled);
  assert.throws(() => budget.reserve(canceled, 1, 1), /replayed/);
  assert.equal(budget.reserve(budget.begin(), 1, 1).reservedMicrousd, 1);
  assert.throws(() => budget.begin(), /request limit/);
  assert.deepEqual(budget.snapshot(), { attempts: 2, generationRequests: 1, reservedMicrousd: 1 });
  const invalid = createModelBudget(limits);
  for (const input of [1001, -1, NaN, 0.5, Infinity]) assert.throws(() => invalid.reserve(invalid.begin(), input, 1));
  assert.equal(invalid.snapshot().reservedMicrousd, 0);
});
