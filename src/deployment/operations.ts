import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runTrustedProcess, type ProcessRunner } from '../providers/shared/process.js';

export interface DeploymentOperator {
  directory: string;
  /** Explicit operator environment, including provider credentials; never written to artifacts. */
  environment: Record<string, string>;
  process?: ProcessRunner;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function operation(options: DeploymentOperator) {
  const directory = realpathSync(options.directory);
  const metadata = JSON.parse(readFileSync(join(directory, 'deployment.json'), 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'execution-host' || !Array.isArray(metadata.files))
    throw Error('Invalid deployment directory: compile an agent-hosting deployment');
  const inputs = () => {
    return hash(
      metadata.files
        .map((file: string) => {
          if (
            !/^[a-zA-Z0-9._/-]+$/.test(file) ||
            file.split('/').some((part) => !part || part === '.' || part === '..')
          )
            throw Error('Invalid deployment filename');
          return `${file}:${hash(readFileSync(join(directory, file)))}`;
        })
        .join('\n'),
    );
  };
  const run = (args: string[], timeoutMs = 300000) =>
    (options.process ?? runTrustedProcess)({
      command: 'tofu',
      args: ['-chdir=' + directory, ...args],
      cwd: directory,
      env: { ...options.environment, TF_IN_AUTOMATION: '1', TF_INPUT: '0' },
      timeoutMs,
      maxOutputBytes: 10485760,
    });
  return { directory, run, inputs };
}
/** Provider schema validation requires plugins but neither cloud credentials nor cloud API calls. */
export async function validateDeploymentInfrastructure(options: DeploymentOperator): Promise<void> {
  const op = operation(options);
  await op.run(['init', '-backend=false', '-input=false', '-no-color']);
  const result = JSON.parse(await op.run(['validate', '-json']));
  if (result.valid !== true) throw Error('Deployment infrastructure validation failed');
}
export async function planDeployment(
  options: DeploymentOperator,
  intent: 'apply' | 'destroy' = 'apply',
): Promise<{ intent: string; planDigest: string }> {
  const op = operation(options);
  await op.run(['init', '-input=false', '-no-color']);
  const before = op.inputs();
  await op.run([
    'plan',
    '-input=false',
    '-no-color',
    '-lock-timeout=30s',
    ...(intent === 'destroy' ? ['-destroy'] : []),
    '-out=deployment.tfplan',
  ]);
  if (op.inputs() !== before) throw Error('Deployment inputs changed during planning');
  const planDigest = hash(readFileSync(join(op.directory, 'deployment.tfplan')));
  writeFileSync(join(op.directory, 'plan-receipt.json'), JSON.stringify({ intent, planDigest, inputs: before }), {
    mode: 0o600,
  });
  return { intent, planDigest };
}
/** Applies only the reviewed saved plan. The caller's explicit invocation authorizes the infrastructure mutation. */
export async function applyDeployment(
  options: DeploymentOperator,
  expectedPlanDigest: string,
): Promise<{ intent: string; outputs: unknown }> {
  const op = operation(options);
  const receipt = JSON.parse(readFileSync(join(op.directory, 'plan-receipt.json'), 'utf8'));
  if (
    !['apply', 'destroy'].includes(receipt.intent) ||
    receipt.planDigest !== expectedPlanDigest ||
    hash(readFileSync(join(op.directory, 'deployment.tfplan'))) !== expectedPlanDigest ||
    op.inputs() !== receipt.inputs
  )
    throw Error('Deployment plan or configuration changed');
  await op.run(['apply', '-input=false', '-no-color', '-lock-timeout=30s', 'deployment.tfplan'], 3600000);
  if (receipt.intent === 'destroy') {
    const state = JSON.parse(await op.run(['show', '-json']));
    if (typeof state.format_version !== 'string') throw Error('Deployment cleanup state is invalid');
    const count = (module: any): number =>
      (module?.resources?.length ?? 0) +
      (module?.child_modules ?? []).reduce((sum: number, child: unknown) => sum + count(child), 0);
    if (count(state.values?.root_module) !== 0)
      throw Error('Deployment cleanup unconfirmed: resources remain in state');
  }
  return { intent: receipt.intent, outputs: JSON.parse(await op.run(['output', '-json'])) };
}
