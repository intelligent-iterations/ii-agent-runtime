import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudEnvironment } from '../src/cloud-environment.js';

test('cloud authentication stays separate from factory and model credentials', () => {
  assert.deepEqual(cloudEnvironment({ AWS_REGION: 'us-east-1', FACTORY_APP_PRIVATE_KEY: 'private', OPENAI_API_KEY: 'model',
    FACTORY_CLOUD_ENVIRONMENT: '{"AWS_ACCESS_KEY_ID":"synthetic","ARM_CLIENT_ID":"synthetic"}' }),
  { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'synthetic', ARM_CLIENT_ID: 'synthetic' });
});
test('cloud credential secret cannot override executable search paths or inject arbitrary environment variables', () => {
  for (const value of ['null', '[]', '{"PATH":"/tmp"}', '{"NODE_OPTIONS":"--require=bad"}', '{"AWS_REGION":4}', '{"__proto__":{}}', '{"VERCEL_TOKEN":"removed"}', '{"RAILWAY_API_TOKEN":"removed"}', '{"FLY_API_TOKEN":"removed"}']) {
    assert.throws(() => cloudEnvironment({ FACTORY_CLOUD_ENVIRONMENT: value }), /Invalid cloud/);
  }
});
