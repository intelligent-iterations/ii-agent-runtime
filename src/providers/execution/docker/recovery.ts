import { existsSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, digest } from '../../../runtime/configuration.js';
import { runTrustedProcess, type ProcessRunner } from '../../shared/process.js';
import { openTofuWorker } from './provisioning.js';
import { dockerDaemonIdentity, privateDirectory, readOwnedJson, retainOwnedJson, validateDockerReference,
  type DockerTargetCheckpoint } from './retained.js';

/** Reconcile teardown of one retained run. This never provisions or resumes an agent. */
export async function recoverDockerTarget(options: {
  parent: string;
  state: DockerTargetCheckpoint;
  expected: { configurationDigest: string; namespacePolicyImage?: string; workspaceHelperImage?: string };
  executablePath: string;
  process?: ProcessRunner;
  checkpoint?(value: DockerTargetCheckpoint): Promise<void>;
}): Promise<void> {
  const state = JSON.parse(canonicalJson(options.state)) as DockerTargetCheckpoint;
  if (Object.keys(state).sort().join(',') !== 'phase,reference' || !['preparing', 'provisioning', 'cleaned'].includes(state.phase)) throw Error('Invalid retained cleanup phase');
  const reference = validateDockerReference(state.reference, options.expected);
  privateDirectory(options.parent);
  const execute = options.process ?? runTrustedProcess;
  const deadlineMs = Date.now() + 360000;
  const daemonId = await dockerDaemonIdentity(execute, { directory: options.parent, executablePath: options.executablePath });
  if (daemonId !== reference.daemonId) throw Error('Cleanup is bound to another Docker daemon');
  const work = join(options.parent, `agent-runtime-${reference.owner}`);
  const worker = join(work, `worker-${reference.owner}`);
  // One fixed budget for all cleanup, independent of the failed run's signal.
  const bounded: ProcessRunner = request => {
    const timeoutMs = Math.min(request.timeoutMs, deadlineMs - Date.now());
    if (timeoutMs < 1) throw Error('Retained cleanup deadline expired');
    return execute({ ...request, timeoutMs });
  };
  const absent = async () => {
    for (const args of [['ps', '--all', '--quiet'], ['network', 'ls', '--quiet'], ['volume', 'ls', '--quiet']]) {
      const output = await bounded({ command: 'docker', args: [...args, '--filter', `label=agent-runtime.owner=${reference.owner}`],
        cwd: options.parent, env: { PATH: options.executablePath, HOME: options.parent }, timeoutMs: 30000, maxOutputBytes: 1048576 });
      if (output.trim()) throw Error('Retained worker absence unconfirmed');
    }
  };
  if (!existsSync(work)) {
    if (state.phase === 'provisioning') throw Error('Retained worker state is missing; cleanup is unconfirmed');
    await absent();
    await options.checkpoint?.({ phase: 'cleaned', reference });
    return;
  }
  privateDirectory(work, reference.owner);
  const proofPath = join(work, '.cleanup-proof.json');
  if (existsSync(proofPath)) {
    const proof = readOwnedJson(work, '.cleanup-proof.json');
    if (proof.schemaVersion !== 1 || proof.owner !== reference.owner || proof.referenceDigest !== digest(canonicalJson(reference))) throw Error('Retained cleanup proof changed');
  } else if (existsSync(worker)) {
    // The original module/state and real resource labels are checked before
    // the pinned provider plugin receives authority to destroy anything.
    const provisioner = openTofuWorker({ parent: work, owner: reference.owner, resume: reference.resources,
      executablePath: options.executablePath, process: bounded,
      ...(reference.namespacePolicyImage ? { namespacePolicyImage: reference.namespacePolicyImage } : {}),
      ...(reference.workspaceHelperImage ? { workspaceHelperImage: reference.workspaceHelperImage } : {}) });
    await provisioner.close();
  } else if (state.phase !== 'preparing') {
    throw Error('Retained worker state is incomplete; cleanup is unconfirmed');
  }
  await absent();
  retainOwnedJson(work, '.cleanup-proof.json', { schemaVersion: 1, owner: reference.owner, referenceDigest: digest(canonicalJson(reference)) });
  await options.checkpoint?.({ phase: 'cleaned', reference });
  privateDirectory(work, reference.owner);
  if (readdirSync(work).some(name => !['.owner', '.cleanup-proof.json'].includes(name))) throw Error('Retained directory cleanup unconfirmed');
  unlinkSync(proofPath); unlinkSync(join(work, '.owner')); rmdirSync(work);
}
