#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { compileDeployment, writeDeployment } from './compile.js';
import { validateDeploymentInfrastructure, planDeployment, applyDeployment } from './operations.js';
import { terminalText } from '../cli/presentation.js';

const commands = {
  compile: { usage: 'compile <configuration.json> --output-directory <directory>', description: 'Compile execution-host infrastructure.', flags: ['output-directory'], required: ['output-directory'] },
  validate: { usage: 'validate <directory>', description: 'Validate infrastructure against provider schemas.', flags: [], required: [] },
  plan: { usage: 'plan <directory> [--destroy]', description: 'Save an infrastructure plan and review digest.', flags: ['destroy'], required: [] },
  apply: { usage: 'apply <directory> --plan-digest <digest>', description: 'Apply a reviewed saved plan. Changes infrastructure.', flags: ['plan-digest'], required: ['plan-digest'] },
} as const;
type Command = keyof typeof commands;
class UsageError extends Error {}
let jsonErrors = false;
function help(command?: Command): string {
  return ['II Agent Runtime | Execution-host infrastructure', '',
    ...(command ? [`Usage: ii-agent-runtime ${commands[command].usage}`, '', commands[command].description] : [
      'Usage: ii-agent-runtime <command> [options]', '',
      ...Object.entries(commands).map(([name, spec]) => `  ${name.padEnd(10)} ${spec.description}`),
      '', 'Workflow: compile -> validate -> plan -> review saved plan -> apply',
    ]), '', 'Options:',
    '  --format <text|json>  Text in terminals; legacy output when redirected.',
    '  -h, --help            Show help. Use <command> --help for command syntax.', '',
    'Exit status: 0 success, 1 operation failed, 2 invalid arguments.',
    'Permissions preflight is a library API. Schema validation is not a security assessment.',
  ].join('\n');
}
async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: {
      'output-directory': { type: 'string' }, 'plan-digest': { type: 'string' },
      destroy: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, format: { type: 'string' },
    } });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments'); }
  const { values, positionals } = parsed;
  jsonErrors = values.format === 'json';
  if (values.format !== undefined && !['text', 'json'].includes(values.format)) throw new UsageError('--format must be text or json');
  const [name, path] = positionals;
  if (!name && (values.help || process.argv.length === 2)) { console.log(help()); return; }
  if (!name || !Object.hasOwn(commands, name)) throw new UsageError('Specify a supported command: compile, validate, plan, apply');
  const command = name as Command;
  if (values.help) { console.log(help(command)); return; }
  const spec = commands[command];
  if (!path || positionals.length !== 2) throw new UsageError(`Usage: ii-agent-runtime ${spec.usage}`);
  for (const flag of Object.keys(values)) {
    if (!['format', 'help', ...spec.flags].includes(flag)) throw new UsageError(`--${flag} is not valid for ${command}`);
  }
  for (const flag of spec.required) if (!values[flag]) throw new UsageError(`Missing --${flag}. Usage: ii-agent-runtime ${spec.usage}`);
  const text = values.format === 'text' || values.format === undefined && process.stdout.isTTY;
  const emit = (result: unknown, lines: string[]) => console.log(text
    ? ['II Agent Runtime | Execution-host infrastructure', '', ...lines.map(terminalText)].join('\n')
    : JSON.stringify(result));
  if (command === 'compile') {
    const artifact = compileDeployment(JSON.parse(readFileSync(path, 'utf8')));
    writeDeployment(values['output-directory']!, artifact);
    emit({ provider: artifact.provider, configurationDigest: artifact.configurationDigest }, [
      'COMPILED', `Provider: ${artifact.provider}`, `Configuration: ${artifact.configurationDigest}`,
      `Directory: ${values['output-directory']}`, 'Next: validate the compiled directory before planning.',
      'Compilation does not validate provider schemas or deploy infrastructure.',
    ]);
    return;
  }
  const options = { directory: path, environment: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  };
  if (command === 'validate') {
    await validateDeploymentInfrastructure(options);
    if (!text && values.format === undefined) console.log('Infrastructure schema validation passed');
    else emit({ status: 'passed', validation: 'infrastructure-schema' }, [
      'SCHEMA VALIDATION PASSED', `Directory: ${path}`, 'Next: create and review an infrastructure plan.',
      'Schema validation does not establish effective permissions or cloud compatibility.',
    ]);
  } else if (command === 'plan') {
    const result = await planDeployment(options, values.destroy ? 'destroy' : 'apply');
    emit(result, ['PLAN SAVED', `Intent: ${result.intent}`, `Plan digest: ${result.planDigest}`,
      `Directory: ${path}`, 'Review deployment.tfplan before applying with --plan-digest.']);
  } else {
    const result = await applyDeployment(options, values['plan-digest']!);
    emit(result, ['PLAN APPLIED', `Intent: ${result.intent}`, `Directory: ${path}`,
      `Outputs: ${JSON.stringify(result.outputs)}`]);
  }
}
main().catch(error => {
  const usage = error instanceof UsageError;
  const message = error instanceof Error ? error.message : 'Deployment failed';
  console.error(jsonErrors ? JSON.stringify({ error: { code: usage ? 'INVALID_ARGUMENTS' : 'OPERATION_FAILED', message } })
    : `Error: ${terminalText(message)}${usage ? '\nRun ii-agent-runtime --help for usage.' : ''}`);
  process.exitCode = usage ? 2 : 1;
});
