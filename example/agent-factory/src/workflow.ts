import { parseSetup } from '@intelligent-iterations/ii-agent-runtime';

function render(repository: string, input: unknown, verification: boolean): string {
  const setup = parseSetup(input);
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repository)) throw Error('Invalid repository');
  if (setup.harness.name !== (verification ? 'verification' : 'codex')) throw Error('Unexpected workflow harness');
  if (verification && setup.secrets.length) throw Error('Verification setup must be credential-free');
  if (setup.secrets.some(secret => secret.repository !== repository)) throw Error('Workflow cannot inject another repository’s secrets');
  if ((!verification && setup.secrets.length !== 1) || setup.secrets.some(secret => secret.organization !== undefined || secret.environment !== undefined)) throw Error('Worker workflow requires one fixed repository secret');
  for (const secret of setup.secrets) {
    if (['PATH', 'HOME', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'].includes(secret.key) || secret.key.startsWith('GITHUB_') || secret.key.startsWith('RUNNER_')) {
      throw Error('Secret name conflicts with worker control environment');
    }
  }
  const envLines = verification ? [] : [`          FACTORY_SECRET_0: "${'${{ secrets.' + setup.secrets[0]!.key + ' }}'}"`];
  return [
    `name: Factory ${verification ? 'verification' : 'worker'}`,
    'run-name: factory-${{ inputs.attempt_id }}',
    'on:', '  workflow_dispatch:', '    inputs:',
    '      attempt_id:', '        type: string', '        required: true',
    '      runner_label:', '        type: string', '        required: true',
    'permissions: {}', 'jobs:', '  agent:',
    '    runs-on: [self-hosted, "${{ inputs.runner_label }}"]',
    '    timeout-minutes: 60', '    steps:',
    '      - name: Verify staged attempt and workflow revision',
    '        env:', '          FACTORY_ATTEMPT: "${{ inputs.attempt_id }}"',
    '        run: |',
    '          node --input-type=module -e \'' +
      'import {readFileSync} from "node:fs"; ' +
      'const a=JSON.parse(readFileSync("/opt/factory/workload/attempt.json","utf8")); ' +
      'if(a.attemptId!==process.env.FACTORY_ATTEMPT || a.workflowCommit!==process.env.GITHUB_SHA) process.exit(1);' + "'",
    `      - name: ${verification ? 'Run protected acceptance checks' : 'Run staged worker'}`,
    ...(verification ? [] : ['        env:', ...envLines]),
    verification ? '        run: exec sudo -n /bin/sh /opt/factory/workload/verify.sh' : '        run: exec node /opt/factory/workload/worker.mjs',
    '',
  ].join('\n');
}

/** One approved worker workflow for every coding agent; each run selects named secrets. */
export function renderWorkerWorkflow(repository: string, input: unknown): string { return render(repository, input, false); }

/** Independent verification gets a separate runner and never receives secret references. */
export function renderVerificationWorkflow(repository: string, input: unknown): string { return render(repository, input, true); }
