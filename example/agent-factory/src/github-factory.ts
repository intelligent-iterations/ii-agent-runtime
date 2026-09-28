import { factoryRunnerOptions } from './defaults.js';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGitHubTransport, inspectGitHubSecret } from '@intelligent-iterations/ii-agent-runtime';
import type { ControllerOptions } from './controller.js';
import type { FactoryConfig } from './index.js';
import { createUsageLedger } from './usage-ledger.js';
import { createUsageReporter, type UsageBilling } from './usage-report.js';

export interface GitHubFactoryInfrastructure {
  runner: { groupId: number; workFolder: string };
  repository: string;
  transport: ControllerOptions['transport'];
  checks: ControllerOptions['checks'];
  binaries: ControllerOptions['binaries'];
  verificationRoot: string;
  verificationOutputs: string;
}
export interface GitHubFactoryOptions {
  runner?: { groupId: number; workFolder: string };
  sourceBundle?: ControllerOptions['sourceBundle'];
  project: string;
  directory: string;
  repository: string;
  roles: FactoryConfig['roles'];
  workflows: ControllerOptions['workflows'];
  binaries: ControllerOptions['binaries'];
  coordination?: ControllerOptions['coordination'];
  authenticatedFetch: typeof fetch;
  publish?: ControllerOptions['publish'];
  agentGrant?: ControllerOptions['agentGrant'];
  endAgentGrant?: ControllerOptions['endAgentGrant'];
  subject: string;
  authorize: ControllerOptions['checks']['authorize'];
  billing: UsageBilling;
  acceptance(infrastructure: GitHubFactoryInfrastructure): Pick<ControllerOptions, 'verify' | 'recoverVerification'>;
}

/** Factory-owned wiring over runtime providers; no deployment or credential request occurs here. */
export function configureGitHubFactory(input: GitHubFactoryOptions) {
  if (!input.project.trim() || !input.subject.trim() || !input.directory.trim() ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(input.repository)) throw Error('Invalid factory installation');
  if (typeof input.authorize !== 'function' || typeof input.authenticatedFetch !== 'function' || typeof input.acceptance !== 'function') throw Error('Provider authentication, authorization and acceptance are required');
  mkdirSync(resolve(input.directory), { recursive: true, mode: 0o700 });
  const directory = realpathSync(resolve(input.directory));
  const verificationRoot = join(directory, 'verification'); const verificationOutputs = join(directory, 'verification-outputs');
  for (const path of [verificationRoot, verificationOutputs]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const transport = createGitHubTransport(input.authenticatedFetch);
  const checks = { subject: input.subject, authorize: input.authorize, inspectSecret: (reference: Parameters<typeof inspectGitHubSecret>[1]) => inspectGitHubSecret(transport, reference) };
  const binaries = structuredClone(input.binaries);
  const runner = structuredClone(input.runner ?? factoryRunnerOptions);
  const acceptance = input.acceptance({ repository: input.repository, transport, checks, binaries, runner, verificationRoot, verificationOutputs });
  if (typeof acceptance.verify !== 'function') throw Error('Acceptance must supply an independent verifier');
  const client: FactoryConfig = { project: input.project, database: join(directory, 'work.sqlite'), roles: structuredClone(input.roles) };
  const ledger = createUsageLedger({ directory: join(directory, 'accounting'), destinationId: 'factory-on-prem' });
  try {
    const options: ControllerOptions = {
      factory: client, stateRoot: directory, runner, repository: input.repository, transport, checks, binaries,
      ...(input.sourceBundle ? { sourceBundle: input.sourceBundle } : {}),
      workflows: structuredClone(input.workflows),
      ...(input.coordination ? { coordination: structuredClone(input.coordination) } : {}),
      verify: acceptance.verify,
      ...(input.publish ? { publish: input.publish } : {}),
      ...(input.agentGrant ? { agentGrant: input.agentGrant } : {}),
      ...(input.endAgentGrant ? { endAgentGrant: input.endAgentGrant } : {}),
      ...(acceptance.recoverVerification ? { recoverVerification: acceptance.recoverVerification } : {}),
      reportUsage: createUsageReporter({ destinationId: 'factory-on-prem', billing: input.billing, deliver: ledger.deliver }),
    };
    let disposed = false;
    return { options, client: structuredClone(client), dispose() { if (!disposed) { disposed = true; ledger.close(); } } };
  } catch (error) { ledger.close(); throw error; }
}
