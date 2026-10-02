#!/usr/bin/env node
import { Command, Option } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recoverConnectionLock } from './connection-store.js';
import { compileConfigurationFile, saveConfigurationArtifact } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { launchFromHub } from './hub-launch.js';
import { runInit, type InitOptions } from './init-command.js';
import { CURRENT_LAYOUT, PRODUCT_NAME } from './identity.js';

const execute = promisify(execFile);
async function ghCredential(): Promise<string> {
  try {
    const result = await execute('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', maxBuffer: 32768, timeout: 20000 });
    const token = result.stdout.trim();
    if (!token) throw Error();
    return token;
  } catch { throw Error('GitHub CLI authentication unavailable. Run gh auth login for github.com.'); }
}
async function openBrowser(url: string, printOnly = false): Promise<void> {
  if (!/^https:\/\/github\.com\//.test(url) && !/^http:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9]+\/start$/.test(url)) throw Error('Invalid browser destination');
  if (printOnly) { console.log(`Open this onboarding URL in your browser: ${url}`); return; }
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  try { await execute(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { timeout: 20000, maxBuffer: 16384 }); }
  catch { console.log(`Open this onboarding URL in your browser: ${url}`); }
}

const program = new Command().name('software-factory').description('Connect GitHub and configure issue-driven agents.');
program.command('hub-launch').description('Verify, reserve and execute the agent requested by one hub issue event.')
  .action(async () => { await launchFromHub(); });
program.command('recover-lock').requiredOption('--directory <path>', 'existing connection metadata directory')
  .description('Remove an interrupted onboarding lock only after its recorded process is proven absent.')
  .action((options: { directory: string }) => {
    recoverConnectionLock(options.directory);
    console.log('Connection lock recovered. Rerun init to reconcile the recorded setup phase.');
  });
program.command('validate').argument('<configuration>', 'YAML or JSON configuration file')
  .description('Validate configuration and print its canonical identities without launching an agent.')
  .action((path: string) => {
    const compiled = compileConfigurationFile(path);
    console.log(JSON.stringify({ setupDigest: compiled.setupDigest, artifactDigest: compiled.artifactDigest }));
  });
program.command('compile').argument('<configuration>', 'YAML or JSON configuration file')
  .requiredOption('--output-directory <path>', 'existing parent directory for a new configuration artifact')
  .description('Save validated canonical JSON and its integrity manifest in a new artifact directory.')
  .action((path: string, options: { outputDirectory: string }) => {
    const compiled = compileConfigurationFile(path);
    const directory = saveConfigurationArtifact(options.outputDirectory, compiled.configuration);
    console.log(JSON.stringify({ directory, setupDigest: compiled.setupDigest, artifactDigest: compiled.artifactDigest }));
  });
program.command('init').description(`Create the organization's private ${PRODUCT_NAME} hub, where issues ask agents to change any of its repositories.`)
  .option('--organization <name>', 'GitHub organization (prompted when omitted)')
  .option('--hub-repository <name>', `private repository that holds the keys and runs agents (default: ${CURRENT_LAYOUT.defaultHubRepository}, or the existing hub)`)
  .option('--directory <path>', 'private connection metadata directory')
  .option('--runtime-repository <owner/repository>', 'runtime source used by the hub workflow')
  .option('--runtime-revision <sha>', 'immutable runtime source commit used by the hub workflow')
  .option('--private-runtime', 'the runtime source is private: give the hub a read-only deploy key for it')
  .option('--runtime-config <path>', 'YAML or JSON agent defaults; targetRepository and App fields are filled in per repository')
  // Each organization builds its own worker image (see the README); these point the hub at it.
  .addOption(new Option('--worker-image <reference>', 'your worker image, built from worker-image/Dockerfile and pinned by digest'))
  .addOption(new Option('--worker-image-signer <owner/repository>', 'repository whose build attestation the worker image must carry (optional)'))
  .option('--print-urls', 'print approval URLs instead of opening a local browser (remote or SSH sessions)')
  .option('--callback-port <port>', 'fixed loopback callback port, for forwarding to a remote browser')
  .action(async (options: InitOptions) => { await runInit(options, { ghCredential, openBrowser }); });

program.parseAsync().catch(error => { console.error(error instanceof Error ? error.message : 'Factory operation failed'); process.exitCode = 1; });
