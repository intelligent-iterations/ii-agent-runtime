import { factoryTartOptions, factoryLibvirtOptions, factoryRunnerOptions } from './defaults.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { parseSetup, tartOptions, libvirtOptions } from '@intelligent-iterations/ii-agent-runtime';
import { installFactoryWorkflows, type WorkflowInstallationTransport } from './workflow-installation.js';

/** HTTP is permitted only for a registry on this host; remote image pulls use TLS. */
export function imagePullArguments(image: string): string[] {
  const authority = image.split('/')[0] ?? '';
  const loopback = /^(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(authority);
  return ['pull', ...(loopback ? ['--insecure'] : []), image];
}

export interface OnboardingOptions {
  directory: string; repository: string; image: string; codexSecret: string; appConfigPath: string;
  transport: WorkflowInstallationTransport;
  host: { pullImage(image: string): Promise<void>; tofu: string } & ({ tart: string; virsh?: never } | { virsh: string; tart?: never });
}

/** Factory installation has no target code repository; agents supply destinations later. */
export async function onboardFactory(options: OnboardingOptions) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
      !/^[A-Z_][A-Z0-9_]{0,254}$/.test(options.codexSecret) || options.codexSecret.startsWith('GITHUB_') ||
      !options.appConfigPath) throw Error('Invalid factory configuration');
  const root = resolve(options.directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw Error('Installation directory must be canonical');
  const provider = 'virsh' in options.host ? 'libvirt' : 'tart';
  const setup = parseSetup({ schemaVersion: 1, id: 'code', revision: '1', harness: { name: 'codex', version: '0.156.1' },
    deployment: { provider, options: provider === 'libvirt' ? factoryLibvirtOptions() : factoryTartOptions(), image: options.image, cpu: 2, memoryMiB: 2048 },
    secrets: [{ provider: 'github', repository: options.repository, key: options.codexSecret }], capture: { paths: ['candidate.bundle'] } });
  const installationPath = join(root, 'installation.json');
  if (existsSync(installationPath)) {
    const existing = JSON.parse(readFileSync(installationPath, 'utf8'));
    if (existing.repository !== options.repository || existing.appConfigPath !== options.appConfigPath || existing.roles?.code?.setup?.deployment?.image !== options.image ||
        existing.roles?.code?.credentialKey !== options.codexSecret) throw Error('Existing installation differs; use a separate directory or an explicit migration');
    try { provider === 'libvirt' ? libvirtOptions(existing.roles.code.setup) : tartOptions(existing.roles.code.setup); }
    catch { throw Error('Existing installation predates explicit provider settings; finish pending work with its original checkout, then use a new installation directory'); }
    for (const name of ['agents.yaml', 'controller.mjs']) {
      if (!existsSync(join(root, name))) throw Error(`Existing installation is missing ${name}; restore it before rerunning setup`);
    }
    await verifySecretAndImage();
    return { directory: root, existing: true };
  }
  async function verifySecretAndImage() {
    const secret = await options.transport.request('GET', `/repos/${options.repository}/actions/secrets/${options.codexSecret}`);
    if (secret.status !== 200) throw Error(`Add the ${options.codexSecret} Actions secret in ${options.repository}, then rerun setup`);
    await options.host.pullImage(options.image);
  }
  await verifySecretAndImage();
  const bindings = await installFactoryWorkflows({ repository: options.repository, setup, transport: options.transport });
  const verificationSetup = { ...setup, id: 'acceptance', harness: { name: 'verification', version: '1' }, secrets: [], capture: { paths: ['verification.json'] } };
  const installation = { project: options.repository.replace('/', '-'), repository: options.repository,
    appConfigPath: options.appConfigPath, directory: './state',
    roles: { code: { kind: 'code', authMode: 'api-key', credentialKey: options.codexSecret, instructions: 'Implement the requested change and verify it.', setup } },
    ...bindings, verificationSetup, runner: { ...factoryRunnerOptions }, binaries: provider === 'libvirt'
      ? { virsh: options.host.virsh, tofu: options.host.tofu } : { tart: options.host.tart, tofu: options.host.tofu },
    agentsSource: './agents.yaml', agentsManifest: './state/agents.resolved.yaml', acceptanceChecks: [],
    coordination: { maxAgents: 2 }, billing: { mode: 'metered_api', provider: 'openai' } };
  const save = (name: string, content: string) => {
    const path = join(root, name);
    if (existsSync(path)) return; // Resume after an interrupted setup without replacing user edits.
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  };
  save('agents.yaml', '# Add agents here, then run the factory launch command.\n# - {name: login, repository: your-org/app, prompt: Fix login validation}\n' + stringify({ schemaVersion: 1, maxConcurrentAgents: 2,
    defaults: { codexSecret: options.codexSecret }, profiles: {
      web: { image: options.image, cpu: 2, memoryMiB: 2048 },
      app: { image: options.image, cpu: 2, memoryMiB: 4096 },
      android: { enabled: false, cpu: 4, memoryMiB: 8192 },
    }, agents: [] }));
  let controller = readFileSync(fileURLToPath(new URL('../examples/controller.mjs', import.meta.url)), 'utf8');
  controller = controller.replace("'@intelligent-iterations/agent-factory-example'", JSON.stringify(pathToFileURL(fileURLToPath(new URL('./index.js', import.meta.url))).href))
    .replace("'@intelligent-iterations/ii-agent-runtime'", JSON.stringify(import.meta.resolve('@intelligent-iterations/ii-agent-runtime')));
  save('controller.mjs', controller);
  save('.gitignore', 'state/\nclient.json\ninstallation.json\ncontroller.mjs\n');
  const pending = installationPath + '.pending';
  writeFileSync(pending, JSON.stringify(installation, null, 2) + '\n', { mode: 0o600 });
  renameSync(pending, installationPath);
  return { directory: root, existing: false };
}
