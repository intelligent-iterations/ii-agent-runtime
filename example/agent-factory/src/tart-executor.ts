import { factoryRunnerOptions } from './defaults.js';
import { join } from 'node:path';
import {
  prepareTartDeployment, deployTart, startTartVM, executeTartGuest, destroyTart, recoverDeploymentLock,
  runnerIntent, registerGitHubRunner, findGitHubRunner, removeGitHubRunner,
  parseSetup, type CheckContext, type DeploymentManifest, type GitHubTransport,
  type RunnerIntent, type RunnerReceipt, type LibvirtManifest,
  prepareLibvirtDeployment, deployLibvirt, startLibvirtVM, executeLibvirtGuest, destroyLibvirt,
  recoverLibvirtLock,
} from '@intelligent-iterations/ii-agent-runtime';
import type { AttemptExecutor, ExecutionContext } from './local-coordinator.js';

/** Factory-owned job protocol. Implementations must retain outputs on operator storage before returning. */
export interface FactoryJob {
  run(context: ExecutionContext, resource: { manifestPath: string; runner: RunnerReceipt }, release: () => Promise<void>): ReturnType<AttemptExecutor>;
  /** Stop or reconcile submitted work before its runner and VM can be removed. Must be idempotent. */
  reconcile(context: ExecutionContext): Promise<void>;
}
export interface TartExecutorOptions {
  onCleanup?: (context: ExecutionContext) => Promise<void>;
  runner?: { groupId: number; workFolder: string };
  root: string;
  binaries: DeploymentManifest['binaries'];
  repository: string;
  transport: GitHubTransport;
  checks: CheckContext;
  job: FactoryJob;
}
/** All infrastructure implementation comes from the runtime's public package interface. */
const runtime = {
  prepareTartDeployment, deployTart, startTartVM, executeTartGuest, destroyTart, recoverDeploymentLock,
  runnerIntent, registerGitHubRunner, findGitHubRunner, removeGitHubRunner,
};
export type TartInfrastructure = typeof runtime;
const linuxRuntime = {
  prepare: prepareLibvirtDeployment, deploy: deployLibvirt, start: startLibvirtVM,
  execute: executeLibvirtGuest, destroy: destroyLibvirt, recover: recoverLibvirtLock,
  runnerIntent, registerGitHubRunner, findGitHubRunner, removeGitHubRunner,
};
export type LibvirtInfrastructure = typeof linuxRuntime;
type CommonOptions = Omit<TartExecutorOptions, 'binaries'>;
interface VmInfrastructure<B> {
  prepare(root: string, input: unknown, binaries: B): { directory: string };
  deploy(path: string, context: CheckContext): Promise<{ present: boolean }>;
  start(path: string): Promise<void>;
  execute(path: string, command: string[], input?: string | Uint8Array): Promise<string>;
  destroy(path: string): Promise<{ present: boolean }>;
  recover(path: string): void | Promise<void>;
  runnerIntent: typeof runnerIntent;
  registerGitHubRunner: typeof registerGitHubRunner;
  findGitHubRunner: typeof findGitHubRunner;
  removeGitHubRunner: typeof removeGitHubRunner;
}

// Executed inside the dedicated guest. Registration bytes use stdin, not host arguments or records.
const startRunner = `import json, os, pwd, stat, subprocess, sys
configuration = sys.stdin.read()
account = pwd.getpwnam('agent')
diag='/opt/actions-runner/_diag'
os.makedirs(diag, exist_ok=True)
if not stat.S_ISDIR(os.lstat(diag).st_mode): raise ValueError('Invalid runner diagnostic directory')
os.chown(diag, account.pw_uid, account.pw_gid)
os.makedirs('/results', exist_ok=True)
log = os.open('/results/runner.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.fchown(log, account.pw_uid, account.pw_gid)
def identity():
    os.initgroups('agent', account.pw_gid)
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
process = subprocess.Popen(['/opt/actions-runner/run.sh', '--jitconfig', configuration],
    cwd='/opt/actions-runner', stdin=subprocess.DEVNULL, stdout=log, stderr=log,
    env={'HOME': account.pw_dir, 'PATH': '/usr/local/bin:/usr/bin:/bin', 'USER': 'agent'},
    preexec_fn=identity, start_new_session=True)
os.close(log)
print(json.dumps({'pid': process.pid}))
`;

/** Owns factory attempt ordering; runtime remains unaware of tasks, coordinators and harnesses. */
function createExecutor<B>(options: CommonOptions & { binaries: B }, infrastructure: VmInfrastructure<B>) {
  async function cleanup(context: ExecutionContext): Promise<void> {
    // A lost dispatch response must be reconciled before deleting execution resources.
    await options.job.reconcile(context);
    context.checkpoint('jobReconciled', true);
    const intent = context.record('runnerIntent') as RunnerIntent | null;
    if (intent) {
      const retained = context.record('runnerReceipt') as RunnerReceipt | null;
      const existing = await infrastructure.findGitHubRunner(options.transport, intent);
      if (retained && existing && existing.receipt.runnerId !== retained.runnerId) throw Error('Runner ownership changed during cleanup');
      if (existing) await infrastructure.removeGitHubRunner(options.transport, existing.receipt);
      context.checkpoint('runnerRemoved', true);
    }
    const manifestPath = context.record('manifestPath');
    if (typeof manifestPath === 'string') {
      const observed = await infrastructure.destroy(manifestPath);
      if (observed.present) throw Error('VM removal is unconfirmed');
      context.checkpoint('vmRemoved', true);
    }
    await options.onCleanup?.(context);
  }

  const execute: AttemptExecutor = async context => {
    if (context.record('manifestPath') || context.record('runnerIntent')) {
      throw Error('Existing attempt resources require recovery');
    }
    if (context.cancelled()) return { outcome: 'cancelled', result: { reason: 'cancelled_before_deployment' } };
    const input = JSON.parse(context.task.input) as { role?: { setup?: unknown } };
    const setup = parseSetup(input.role?.setup);
    let outcome: Awaited<ReturnType<AttemptExecutor>>;
    let phase = 'prepare';
    const enter = (next: string) => { phase = next; context.checkpoint('executionPhase', phase); };
    try {
      enter('prepare');
      const manifest = infrastructure.prepare(options.root, setup, options.binaries);
      const manifestPath = join(manifest.directory, 'manifest.json');
      context.checkpoint('manifestPath', manifestPath);
      enter('deploy');
      await infrastructure.deploy(manifestPath, options.checks);
      if (context.cancelled()) {
        outcome = { outcome: 'cancelled', result: { reason: 'cancelled_after_deployment' } };
      } else {
        enter('start');
        await infrastructure.start(manifestPath);
        enter('guest-readiness');
        const readinessDeadline = Date.now() + 90_000;
        while (true) {
          if (context.cancelled()) throw Error('Cancelled during guest startup');
          try {
            await infrastructure.execute(manifestPath, ['python3', '-c',
              "import urllib.request; urllib.request.urlopen('https://api.github.com', timeout=5).close()"]);
            break;
          } catch {
            if (Date.now() >= readinessDeadline) throw Error('Guest readiness timed out');
            await new Promise(resolve => setTimeout(resolve, 1_000));
          }
        }
        enter('runner-registration');
        const intent = infrastructure.runnerIntent(options.repository, options.runner ?? factoryRunnerOptions);
        const receipt = await infrastructure.registerGitHubRunner(options.transport, intent, {
          intent: async value => { context.checkpoint('runnerIntent', value); },
          receipt: async value => { context.checkpoint('runnerReceipt', value); },
        }, async configuration => {
          enter('runner-start');
          // Readiness uses the guest agent; no SSH credentials or shared host filesystem.
          await infrastructure.execute(manifestPath, ['sudo', '-n', 'python3', '-c', startRunner], configuration);
          context.checkpoint('runnerStarted', true);
        });
        enter('job');
        outcome = context.cancelled()
          ? { outcome: 'cancelled', result: { reason: 'cancelled_before_job' } }
          : await options.job.run(context, { manifestPath, runner: receipt }, () => cleanup(context));
      }
      context.checkpoint('retainedOutcome', outcome);
    } catch {
      // Errors can contain provider credentials. Persist a stable diagnostic, never raw error text.
      outcome = { outcome: 'failed', result: { reason: 'execution_failed', phase } };
      context.checkpoint('retainedOutcome', outcome);
    }
    await cleanup(context); // An uncertain cleanup throws; the service keeps this attempt active.
    return outcome;
  };

  return {
    execute,
    /** Reconcile retained identities; never repeat launch or dispatch after a crash. */
    async recover(context: ExecutionContext): ReturnType<AttemptExecutor> {
      const manifestPath = context.record('manifestPath');
      if (typeof manifestPath === 'string') await infrastructure.recover(manifestPath);
      await cleanup(context);
      const retained = context.record('retainedOutcome') as Awaited<ReturnType<AttemptExecutor>> | null;
      return retained ?? { outcome: context.cancelled() ? 'cancelled' : 'failed', result: { reason: 'interrupted_attempt_reconciled' } };
    },
  };
}

/** Compatibility entry point for existing macOS installations and injected test adapters. */
export function createTartExecutor(options: TartExecutorOptions, infrastructure: TartInfrastructure = runtime) {
  return createExecutor(options, {
    prepare: infrastructure.prepareTartDeployment, deploy: infrastructure.deployTart,
    start: infrastructure.startTartVM, execute: infrastructure.executeTartGuest,
    destroy: infrastructure.destroyTart, recover: infrastructure.recoverDeploymentLock,
    runnerIntent: infrastructure.runnerIntent, registerGitHubRunner: infrastructure.registerGitHubRunner,
    findGitHubRunner: infrastructure.findGitHubRunner, removeGitHubRunner: infrastructure.removeGitHubRunner,
  });
}

export interface LibvirtExecutorOptions extends CommonOptions { binaries: LibvirtManifest['binaries'] }
export function createLibvirtExecutor(options: LibvirtExecutorOptions, infrastructure: LibvirtInfrastructure = linuxRuntime) {
  return createExecutor(options, infrastructure);
}
