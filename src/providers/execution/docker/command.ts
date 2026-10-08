import type { WorkerCommandRunner } from '../../../pipeline/ports.js';
import type { ProvisionedWorker } from './provisioning.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';

/** Docker owns the container identity and host process environment, never the harness. */
export function dockerWorkerCommand(worker: ProvisionedWorker,
  options: { executablePath?: string; process?: ProcessRunner } = {}): WorkerCommandRunner {
  if (!/^[a-f0-9]{64}$/.test(worker.containerId)) throw Error('Invalid Docker worker identity');
  return request => (options.process ?? runTrustedProcess)({
    ...request, command: 'docker',
    args: ['exec', '--interactive', '--user', '10001:10001', worker.containerId, request.command, ...request.args],
    cwd: worker.directory,
    env: { PATH: options.executablePath ?? '/usr/local/bin:/usr/bin:/bin', HOME: worker.directory },
  });
}
