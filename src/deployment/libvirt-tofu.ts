import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLaunchChecks, type CheckContext } from '../checks.js';
import { commands, toolEnvironment, type CommandExecutor } from './commands.js';
import { libvirtOptions } from './libvirt-options.js';
import { loadLibvirtDeployment } from './libvirt-workspace.js';
import { durableWrite } from './workspace.js';
import { inspectLibvirtDeployment, removeLibvirtVM } from './libvirt.js';

async function invoke(manifestPath: string, action: 'apply' | 'destroy', driver: CommandExecutor): Promise<void> {
  const m = loadLibvirtDeployment(manifestPath);
  const cwd = join(m.directory, 'tofu');
  const module = join(cwd, 'main.tf');
  if (!existsSync(module)) copyFileSync(fileURLToPath(new URL('../../modules/libvirt/main.tf', import.meta.url)), module);
  durableWrite(join(cwd, 'terraform.tfvars.json'), { manifest_path: manifestPath, node_binary: m.binaries.node,
    hook_script: fileURLToPath(new URL('./libvirt-hook.js', import.meta.url)) });
  const timeouts = libvirtOptions(m.setup).timeouts;
  const options = { cwd, env: { ...toolEnvironment(), TF_IN_AUTOMATION: '1' }, timeoutMs: timeouts.tofuMs };
  await driver.run(m.binaries.tofu, ['init', '-input=false', '-no-color'], options);
  await driver.run(m.binaries.tofu, [action, '-input=false', '-auto-approve', '-no-color', `-lock-timeout=${timeouts.tofuLockMs}ms`], options);
}

export async function deployLibvirt(manifestPath: string, context: CheckContext, driver = commands) {
  const m = loadLibvirtDeployment(manifestPath);
  return withLaunchChecks(m.setup, context, async (_, evidence) => {
    durableWrite(join(m.directory, 'validation.json'), evidence);
    await invoke(manifestPath, 'apply', driver);
    const observed = await inspectLibvirtDeployment(manifestPath, driver);
    if (!observed.present || observed.running || observed.cpu !== m.setup.deployment.cpu ||
        observed.memoryMiB !== m.setup.deployment.memoryMiB) throw Error('Deployment not verified');
    return observed;
  });
}

export async function destroyLibvirt(manifestPath: string, driver = commands) {
  let tofuFailed = false;
  try { await invoke(manifestPath, 'destroy', driver); }
  catch { tofuFailed = true; }
  // terraform_data can be tainted or interrupted. Reconcile the owned VM even then.
  const removed = await removeLibvirtVM(manifestPath, driver);
  if (tofuFailed) throw Error('OpenTofu destroy failed; owned VM was reconciled, inspect retained state');
  return removed;
}
