import { compileConfiguration, canonicalJson, type CompiledConfiguration } from '../runtime/configuration.js';
import type { WorkerResources } from './ports.js';

/** The execution target receives no prompt, source-host settings, permissions, or credentials. */
export function workerResources(compiled: CompiledConfiguration): WorkerResources {
  const checked = compileConfiguration(compiled.configuration);
  if (checked.canonical !== compiled.canonical || checked.artifactDigest !== compiled.artifactDigest || checked.setupDigest !== compiled.setupDigest) throw Error('Configuration binding mismatch');
  const { image, cpu, memoryMiB, userNamespaces, diskGiB } = checked.configuration.environment;
  return { image, cpu, memoryMiB, ...(diskGiB === undefined ? {} : { diskGiB }), ...(userNamespaces === undefined ? {} : { userNamespaces }), timeoutSeconds: checked.configuration.limits.timeoutMinutes * 60, configurationDigest: checked.artifactDigest };
}

export function validateWorkerResources(input: WorkerResources): WorkerResources {
  const value = JSON.parse(canonicalJson(input)) as WorkerResources;
  if (Object.keys(value).filter(key => !['userNamespaces', 'diskGiB'].includes(key)).sort().join(',') !== 'configurationDigest,cpu,image,memoryMiB,timeoutSeconds' ||
    (value.diskGiB !== undefined && (!Number.isInteger(value.diskGiB) || value.diskGiB < 1 || value.diskGiB > 80)) ||
    (value.userNamespaces !== undefined && typeof value.userNamespaces !== 'boolean') ||
    !/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value.image) || value.image.length > 512 ||
    !Number.isInteger(value.cpu) || value.cpu < 1 || value.cpu > 4 ||
    !Number.isInteger(value.memoryMiB) || value.memoryMiB < 256 || value.memoryMiB > 8192 ||
    !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 60 || value.timeoutSeconds > 7200 ||
    !/^sha256:[a-f0-9]{64}$/.test(value.configurationDigest)) throw Error('Invalid worker resources');
  return value;
}
