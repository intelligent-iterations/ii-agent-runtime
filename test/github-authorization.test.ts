import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesForPermission } from '../src/providers/github-authorization.js';

test('effective admin access qualifies automatically, unknown/custom roles remain conservative', () => {
  assert.ok(capabilitiesForPermission('admin', 'admin').includes('repository:write'));
  assert.ok(capabilitiesForPermission('write', 'maintain').includes('repository:maintain'));
  assert.ok(!capabilitiesForPermission('write', 'custom-role').includes('repository:maintain'));
  assert.deepEqual(capabilitiesForPermission('none', 'admin'), []);
  assert.deepEqual(capabilitiesForPermission('unknown', 'custom-role'), []);
});
