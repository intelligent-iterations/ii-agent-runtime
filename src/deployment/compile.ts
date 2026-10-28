import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateDeployment, deploymentDigest } from './configuration.js';
import { UnsupportedDeployment, type DeploymentArtifact } from './contracts.js';
import { bootstrap } from '../providers/deployment/bootstrap.js';
import { virtualMachines, virtualMachineDocument } from '../providers/deployment/virtual-machines.js';

/** Composition root. Application names and behavior never enter the infrastructure adapters. */
export function compileDeployment(input: unknown): DeploymentArtifact {
  const declaration = validateDeployment(input);
  if (!Object.hasOwn(virtualMachines, declaration.provider))
    throw new UnsupportedDeployment(declaration.provider, 'agent hosting: no deployment adapter is implemented');
  const cloudInit = bootstrap();
  const maximumUserDataBytes: Record<string, number> = {
    aws: 16384,
    oci: 32000,
    azure: 65535,
  };
  if (Buffer.byteLength(cloudInit) > (maximumUserDataBytes[declaration.provider] ?? 65535))
    throw new UnsupportedDeployment(declaration.provider, 'host bootstrap within user-data size limits');
  return {
    kind: 'execution-host',
    schemaVersion: 1,
    id: declaration.id,
    provider: declaration.provider,
    configurationDigest: deploymentDigest(declaration),
    files: {
      'main.tf.json': JSON.stringify(virtualMachineDocument(declaration, cloudInit), null, 2) + '\n',
      'cloud-init.yaml': cloudInit,
    },
    evidence: { compilation: 'passed', schemaValidation: 'not-run', emulator: 'not-run', live: 'not-run' },
  };
}
export function writeDeployment(directory: string, artifact: DeploymentArtifact): void {
  // A deployment directory owns its state. Never overwrite another deployment or an existing state file.
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, value] of Object.entries(artifact.files)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..'))
      throw Error('Invalid deployment artifact filename');
    mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), value, { mode: 0o600, flag: 'wx' });
  }
  writeFileSync(
    join(directory, 'deployment.json'),
    JSON.stringify({ ...artifact, files: Object.keys(artifact.files) }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
}
