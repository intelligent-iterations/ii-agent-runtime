#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { compileDeployment, writeDeployment } from './compile.js';
import { validateDeploymentInfrastructure, planDeployment, applyDeployment } from './operations.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'output-directory': { type: 'string' },
      'plan-digest': { type: 'string' },
      destroy: { type: 'boolean' },
    },
  });
  const [command, path] = positionals;
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value) throw Error(`Missing --${key}`);
    return value;
  };
  if (!path) throw Error('Use ii-agent-runtime <compile|validate|plan|apply> <file-or-directory>');
  if (command === 'compile') {
    const artifact = compileDeployment(JSON.parse(readFileSync(path, 'utf8')));
    writeDeployment(required('output-directory'), artifact);
    console.log(JSON.stringify({ provider: artifact.provider, configurationDigest: artifact.configurationDigest }));
    return;
  }
  const options = {
    directory: path,
    environment: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
  if (command === 'validate') {
    await validateDeploymentInfrastructure(options);
    console.log('Infrastructure schema validation passed');
  } else if (command === 'plan')
    console.log(JSON.stringify(await planDeployment(options, values.destroy ? 'destroy' : 'apply')));
  else if (command === 'apply') console.log(JSON.stringify(await applyDeployment(options, required('plan-digest'))));
  else throw Error('Unknown deployment command');
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Deployment failed');
  process.exitCode = 1;
});
