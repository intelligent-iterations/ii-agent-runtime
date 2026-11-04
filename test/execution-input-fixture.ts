import type { ExecutionInputs } from '../src/runtime/execution-inputs.js';
import { fixture } from './runtime-fixture.js';

export function inputs(): ExecutionInputs {
  return { schemaVersion: 1, configuration: fixture(), prompt: { kind: 'inline', text: 'Implement the approved change.' },
    repositories: [{ repository: 'example/project', commit: 'a'.repeat(40), localChanges: null }],
    artifacts: [{ role: 'worker-source', artifact: { reference: 'store:worker', digest: `sha256:${'b'.repeat(64)}`, bytes: 100 } }],
    components: [{ name: 'runtime', version: 'revision-1' }],
    model: { provider: 'sample-model', identity: 'sample-model-1', parameters: { temperature: 0 } },
    environment: { LANG: 'C.UTF-8' },
    credentials: [{ provider: 'sample-provider', resource: 'scope:project', key: 'WORKER_CREDENTIAL', assignment: 'read-repository' }],
    coverage: [{ field: 'dependency-network', reason: 'External registry state was not retained' }] };
}
