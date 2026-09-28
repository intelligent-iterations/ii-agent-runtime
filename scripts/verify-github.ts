/** Explicitly invoked live provider proof; never part of the offline test suite. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGitHubTransport, findGitHubRunner, registerGitHubRunner, removeGitHubRunner, runnerIntent, type RunnerReceipt } from '../src/index.js';

const [repository, evidenceDirectory] = process.argv.slice(2);
if (!repository || !evidenceDirectory) throw new Error('Usage: tsx scripts/verify-github.ts owner/repository new-evidence-directory');
const directory = resolve(evidenceDirectory);
mkdirSync(directory, { mode: 0o700 });
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const transport = createGitHubTransport((url, init) => fetch(url, {
  ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` },
}));
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const intent = runnerIntent(repository, { groupId: 1, workFolder: '_work' });
const write = (name: string, value: unknown) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
let receipt: RunnerReceipt | undefined;
let registered = false;
let cleaned = false;
try {
  receipt = await registerGitHubRunner(transport, intent, {
    intent: async value => write('intent.json', value),
    receipt: async value => { receipt = value; write('receipt.json', value); },
  }, async configuration => {
    if (!configuration.length) throw new Error('Missing JIT configuration');
    // Registration proof only: do not install a runner or dispatch any workload here.
    registered = true;
  });
  const found = await findGitHubRunner(transport, intent);
  if (!found || found.receipt.runnerId !== receipt.runnerId) throw new Error('Runner reconciliation failed');
  write('observed.json', found);
} catch {
  process.exitCode = 1;
  write('failure.json', { outcome: 'registration-or-reconciliation-failed', operationId: intent.operationId });
} finally {
  try {
    const found = receipt ?? (await findGitHubRunner(transport, intent))?.receipt;
    if (found) {
      const outcome = await removeGitHubRunner(transport, found);
      const repeated = await removeGitHubRunner(transport, found);
      cleaned = repeated === 'absent';
      write('cleanup.json', { outcome, repeated, operationId: intent.operationId });
    } else {
      write('cleanup.json', { outcome: 'no-runner-observed', operationId: intent.operationId });
    }
  } catch {
    process.exitCode = 1;
    write('cleanup.json', { outcome: 'unknown', operationId: intent.operationId });
  }
  write('summary.json', { registered, cleaned, sourceRevision, nodeVersion: process.version, apiVersion: '2026-03-10', time: new Date().toISOString(), scope: 'GitHub JIT registration, reconciliation and removal only; no VM or job executed' });
  process.stdout.write(JSON.stringify({ registered, cleaned, evidenceDirectory: directory }) + '\n');
}
