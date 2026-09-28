#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { prepareFactoryRepository } from '../dist/onboarding-repository.js';
import { openLocalImage } from '../dist/local-image.js';
import { onboardFactory, imagePullArguments } from '../dist/onboarding.js';
import { appAuthenticatedFetch, openFactoryApp } from '../dist/factory-app-auth.js';
import { createGitHubTransport } from '@intelligent-iterations/ii-agent-runtime';

let localImage;
let appHandle;
try {
  const directory = resolve(process.argv[2] ?? '.factory');
  const appConfigPath = process.env.II_FACTORY_APP_CONFIG;
  if (!appConfigPath) throw Error('Set II_FACTORY_APP_CONFIG to protected local App configuration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const installationPath = resolve(directory, 'installation.json');
  const selectionPath = resolve(directory, 'onboarding.json');
  const saved = existsSync(installationPath)
    ? JSON.parse(readFileSync(installationPath, 'utf8'))
    : existsSync(selectionPath)
      ? JSON.parse(readFileSync(selectionPath, 'utf8'))
      : undefined;
  let repository = saved?.repository;
  let codexSecret = saved?.roles?.code?.credentialKey ?? saved?.codexSecret;
  if (!saved) {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log('Use an existing private factory repository with the App installed and the OpenAI key saved as an Actions secret.');
      repository =
        (
          await terminal.question(
            'Factory repository (OWNER/REPO): ',
          )
        ).trim();
      codexSecret =
        (
          await terminal.question(
            'OpenAI API-key secret name [CODEX_CODE_API_KEY]: ',
          )
        ).trim() || 'CODEX_CODE_API_KEY';
    } finally {
      terminal.close();
    }
  }
  if (
    typeof codexSecret !== 'string' ||
    !/^[A-Z_][A-Z0-9_]{0,254}$/.test(codexSecret) ||
    codexSecret.startsWith('GITHUB_')
  )
    throw Error('Invalid API-key secret name');
  appHandle = openFactoryApp(resolve(appConfigPath), resolve(directory, 'state'));
  const transport = createGitHubTransport(appAuthenticatedFetch(appHandle.app, repository));
  await prepareFactoryRepository(repository, transport);
  if (!existsSync(selectionPath))
    writeFileSync(
      selectionPath,
      JSON.stringify({ repository, codexSecret, appConfigPath: resolve(appConfigPath) }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  const secret = await transport.request(
    'GET',
    `/repos/${repository}/actions/secrets/${codexSecret}`,
  );
  if (secret.status !== 200) throw Error(`Add the ${codexSecret} Actions secret to ${repository}, then rerun setup`);
  const executable = (name) =>
    execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'factory', name], {
      encoding: 'utf8',
    }).trim();
  const linux = process.platform === 'linux' && process.arch === 'x64';
  if (!linux && !(process.platform === 'darwin' && process.arch === 'arm64'))
    throw Error('Use an Apple Silicon Mac or Linux x64 KVM host');
  if (linux) {
    const recipe = fileURLToPath(new URL('../images/linux-x64/build.sh', import.meta.url));
    const built = spawnSync('/bin/bash', [recipe, resolve(directory, 'image-store/linux-build')], { encoding: 'utf8' });
    if (built.status !== 0) throw Error('Could not prepare the Linux x64 worker image; inspect image-store/linux-build/provision.log');
    localImage = { image: built.stdout.trim(), close: async () => {} };
  } else {
    localImage = await openLocalImage(directory, { prepare: true });
  }
  const result = await onboardFactory({
    directory: resolve(process.argv[2] ?? '.factory'),
    repository,
    image: localImage.image,
    codexSecret,
    appConfigPath: resolve(appConfigPath),
    transport,
    host: linux ? {
      virsh: executable('virsh'), tofu: executable('tofu'),
      async pullImage(image) { if (image !== localImage.image) throw Error('Prepared Linux image changed'); },
    } : {
      tart: executable('tart'), tofu: executable('tofu'),
      async pullImage(image) {
        const child = spawnSync('tart', imagePullArguments(image), { stdio: 'inherit' });
        if (child.status !== 0) throw Error('Could not download the factory worker image');
      },
    },
  });
  console.log(
    `Factory ${result.existing ? 'checked' : 'installed'} in ${result.directory}`,
  );
  console.log(`Add agents to ${resolve(result.directory, 'agents.yaml')}`);
  console.log(
    `Then run: npm run launch -- ${JSON.stringify(result.directory)}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await localImage?.close();
  appHandle?.close();
}
