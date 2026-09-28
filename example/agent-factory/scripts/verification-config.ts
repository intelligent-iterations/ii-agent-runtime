import { readFileSync } from 'node:fs';

export interface VerificationConfig {
  repository: string;
  sourceRepository: string;
  workerWorkflowId: number;
  verificationWorkflowId: number;
  workflowRef: string;
  verificationWorkflowRef: string;
  verificationWorkflowCommit: string;
}

export function loadVerificationConfig(path = process.env.FACTORY_VERIFICATION_CONFIG): VerificationConfig {
  if (!path) throw Error('Set FACTORY_VERIFICATION_CONFIG to an implementation-owned JSON file');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw Error('Verification config must be an object');
  const config = value as Record<string, unknown>;
  for (const key of ['repository', 'sourceRepository']) {
    if (typeof config[key] !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(config[key])) throw Error(`Invalid ${key} in verification config`);
  }
  for (const key of ['workerWorkflowId', 'verificationWorkflowId']) {
    if (!Number.isSafeInteger(config[key]) || Number(config[key]) < 1) throw Error(`Invalid ${key} in verification config`);
  }
  for (const key of ['workflowRef', 'verificationWorkflowRef']) {
    if (typeof config[key] !== 'string' || !/^[\w./-]+$/.test(config[key]) || config[key].startsWith('/')) throw Error(`Invalid ${key} in verification config`);
  }
  if (typeof config.verificationWorkflowCommit !== 'string' || !/^[a-f0-9]{40}$/.test(config.verificationWorkflowCommit)) throw Error('Invalid verificationWorkflowCommit in verification config');
  return config as unknown as VerificationConfig;
}
