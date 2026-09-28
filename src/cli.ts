#!/usr/bin/env node
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileSetupJson,
  compileSetupYaml,
  SETUP_SOURCE_MAX_BYTES,
  SetupCompilationError,
} from './authoring.js';
import { checkSetup, LaunchDenied } from './checks.js';
import { commandCheckContext } from './check-command.js';
import { loadDeployment } from './deployment/workspace.js';
import { planTart } from './deployment/opentofu.js';
import { canonicalJson } from './setup.js';

const usage =
  'ii-agent-runtime compile|check --format json|yaml [FILE|-] [--checker EXECUTABLE] [--timeout-ms N] [--plan MANIFEST]';
function parseArguments(args: string[]) {
  const command = args[0];
  if (!['compile', 'check'].includes(command ?? '')) throw Error('usage');
  const flags = new Map<string, string>();
  let path: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      if (
        !['--format', '--checker', '--timeout-ms', '--plan'].includes(arg) ||
        flags.has(arg) ||
        !args[i + 1] ||
        args[i + 1]!.startsWith('--')
      )
        throw Error('usage');
      flags.set(arg, args[++i]!);
    } else {
      if (path !== undefined) throw Error('usage');
      path = arg;
    }
  }
  if (
    !['json', 'yaml'].includes(flags.get('--format') ?? '') ||
    (command === 'compile' && flags.size !== 1)
  )
    throw Error('usage');
  const timeout = Number(flags.get('--timeout-ms') ?? 10_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw Error('usage');
  return {
    command,
    format: flags.get('--format'),
    path,
    checker: flags.get('--checker'),
    plan: flags.get('--plan'),
    timeout,
  };
}
/** Setup inputs remain data-only; a checker is an explicit trusted executable integration. */
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage + '\n');
    return 0;
  }
  let parsed;
  try {
    parsed = parseArguments(args);
  } catch {
    process.stderr.write(
      JSON.stringify({ error: { code: 'USAGE', message: usage } }) + '\n',
    );
    return 2;
  }
  let stage = 'INPUT_READ';
  try {
    const stream =
      parsed.path && parsed.path !== '-'
        ? createReadStream(parsed.path)
        : process.stdin;
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > SETUP_SOURCE_MAX_BYTES)
        throw new SetupCompilationError(
          'INPUT_LIMIT',
          'Setup source exceeds the input limit',
        );
      chunks.push(bytes);
    }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new SetupCompilationError(
        'INPUT_ENCODING',
        'Expected UTF-8 source',
      );
    }
    const result =
      parsed.format === 'yaml'
        ? compileSetupYaml(source)
        : compileSetupJson(source);
    if (parsed.command === 'compile') {
      process.stdout.write(result.json + '\n');
      return 0;
    }
    stage = 'CHECK_FAILED';
    if (
      parsed.plan &&
      canonicalJson(loadDeployment(parsed.plan).setup) !== result.json
    )
      throw Error('Manifest does not match input');
    const context = await commandCheckContext(parsed.checker, parsed.timeout);
    if (parsed.plan) {
      stage = 'PLAN_FAILED';
      const plan = await planTart(parsed.plan, context);
      process.stdout.write(JSON.stringify(plan) + '\n');
      return 0;
    }
    const evidence = await checkSetup(result.setup, context);
    process.stdout.write(JSON.stringify({ evidence }) + '\n');
    return evidence.allowed ? 0 : 3;
  } catch (error) {
    if (error instanceof LaunchDenied) {
      process.stdout.write(JSON.stringify({ evidence: error.evidence }) + '\n');
      return 3;
    }
    const diagnostic =
      error instanceof SetupCompilationError
        ? {
            code: error.code,
            message: error.message,
            line: error.line,
            column: error.column,
            issues: error.issues,
            source: error.source,
          }
        : {
            code: stage,
            message:
              stage === 'INPUT_READ'
                ? 'Unable to read setup source'
                : stage === 'PLAN_FAILED'
                  ? 'Unable to produce deployment plan'
                  : 'Unable to check setup',
          };
    process.stderr.write(JSON.stringify({ error: diagnostic }) + '\n');
    return 1;
  }
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main(process.argv.slice(2));
}
