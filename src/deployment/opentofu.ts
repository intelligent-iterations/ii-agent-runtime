import { canonicalJson } from '../setup.js';
import { tartOptions } from './tart-options.js';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLaunchChecks, type CheckContext } from '../checks.js';
import { commands, toolEnvironment, type CommandExecutor } from './commands.js';
import { durableWrite, loadDeployment, withDeploymentLock } from './workspace.js';
import { inspectTartDeployment, removeTartVM, type VMObservation } from './tart.js';

async function invoke(manifestPath: string, action: 'apply' | 'destroy', driver: CommandExecutor): Promise<void> {
  const m = loadDeployment(manifestPath);
  const cwd = join(m.directory, 'tofu');
  const module = join(cwd, 'main.tf');
  if (!existsSync(module)) copyFileSync(fileURLToPath(new URL('../../modules/tart/main.tf', import.meta.url)), module);
  durableWrite(join(cwd, 'terraform.tfvars.json'), {
    manifest_path: manifestPath, node_binary: m.binaries.node,
    hook_script: fileURLToPath(new URL('./tart-hook.js', import.meta.url)),
  });
  const options = { cwd, env: { ...toolEnvironment(), TF_IN_AUTOMATION: '1' }, timeoutMs: tartOptions(m.setup).timeouts.tofuMs };
  await driver.run(m.binaries.tofu, ['init', '-input=false', '-no-color'], options);
  await driver.run(m.binaries.tofu, [action, '-input=false', '-auto-approve', '-no-color', `-lock-timeout=${tartOptions(m.setup).timeouts.tofuLockMs}ms`], options);
}
/** Every apply obtains fresh checks; callers cannot supply a cached validation record. */
export async function deployTart(manifestPath: string, context: CheckContext, driver = commands): Promise<VMObservation> {
  const m = loadDeployment(manifestPath);
  return withLaunchChecks(m.setup, context, async (_, evidence) => {
    durableWrite(join(m.directory, 'validation.json'), evidence);
    await invoke(manifestPath, 'apply', driver);
    const observed = await inspectTartDeployment(manifestPath, driver);
    if (!observed.present || observed.cpu !== m.setup.deployment.cpu || observed.memoryMiB !== m.setup.deployment.memoryMiB) throw new Error('Deployment not verified');
    return observed;
  });
}
export async function destroyTart(manifestPath: string, driver = commands): Promise<VMObservation> {
  await invoke(manifestPath, 'destroy', driver);
  // A tainted terraform_data resource can skip its destroy hook. Explicitly reconcile the owned VM.
  return removeTartVM(manifestPath, driver);
}

export interface TartPlan {
  evidence: import('../checks.js').LaunchEvidence;
  scope: 'opentofu-state';
  changes: { create: number; update: number; delete: number; read: number; unchanged: number };
}
/** Read-only infrastructure preview; local plan files are private and removed afterward. */
export async function planTart(manifestPath: string, context: CheckContext, driver = commands): Promise<TartPlan> {
  const initial = loadDeployment(manifestPath);
  return withLaunchChecks(initial.setup, context, async (checked, evidence) => withDeploymentLock(manifestPath, async () => {
    const m = loadDeployment(manifestPath);
    if (canonicalJson(m.setup) !== canonicalJson(checked)) throw Error('Deployment changed after authorization');
    const cwd = join(m.directory, 'tofu');
    const module = join(cwd, 'main.tf');
    if (!existsSync(module)) copyFileSync(fileURLToPath(new URL('../../modules/tart/main.tf', import.meta.url)), module);
    durableWrite(join(cwd, 'terraform.tfvars.json'), {
      manifest_path: manifestPath, node_binary: m.binaries.node,
      hook_script: fileURLToPath(new URL('./tart-hook.js', import.meta.url)),
    });
    const options = { cwd: m.directory, env: { ...toolEnvironment(), TF_IN_AUTOMATION: '1' }, timeoutMs: tartOptions(m.setup).timeouts.tofuMs };
    const temporary = mkdtempSync(join(m.directory, 'plan-'));
    const plan = join(temporary, 'preview.tfplan');
    try {
      await driver.run(m.binaries.tofu, [`-chdir=${cwd}`, 'init', '-input=false', '-no-color'], options);
      await driver.run(m.binaries.tofu, [`-chdir=${cwd}`, 'plan', '-input=false', '-no-color',
        `-lock-timeout=${tartOptions(m.setup).timeouts.tofuLockMs}ms`, `-out=${plan}`], options);
      const result = JSON.parse(await driver.run(m.binaries.tofu, [`-chdir=${cwd}`, 'show', '-json', plan], options));
      if (!result || typeof result !== 'object' || result.errored === true ||
          typeof result.format_version !== 'string' || !result.format_version.startsWith('1.') ||
          !result.planned_values || (result.resource_changes !== undefined && !Array.isArray(result.resource_changes))) throw Error('Invalid OpenTofu plan');
      const changes = { create: 0, update: 0, delete: 0, read: 0, unchanged: 0 };
      for (const resource of result.resource_changes ?? []) {
        const actions: unknown = resource?.change?.actions;
        if (!Array.isArray(actions) || !actions.length || actions.some(action => !['create','update','delete','read','no-op'].includes(action))) throw Error('Invalid plan actions');
        for (const action of actions) changes[action === 'no-op' ? 'unchanged' : action as 'create'|'update'|'delete'|'read']++;
      }
      return { evidence, scope: 'opentofu-state', changes };
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }));
}
