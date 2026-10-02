import { defaultPolicy } from '../src/defaults.js';

/** The default policy with the worker image an organization passes at onboarding (`--worker-image`). */
export function samplePolicy(): Record<string, any> {
  const policy = defaultPolicy() as Record<string, any>;
  policy.environment = { ...policy.environment, image: `example/worker@sha256:${'a'.repeat(64)}` };
  return policy;
}
