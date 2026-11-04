import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiveModelConfig } from './model.js';
import { PRIVATE, projectFiles } from './workspace.js';

export const DEFAULT_TASK = 'The test script fails. Investigate the cause and hand a precise fix to the coder.';

export interface HandoffConfig {
  root: string;
  files: string[];
  task: string;
  testScript: string;
  /** Exact files the coder may ever write; undefined with --broad. */
  writable?: string[];
  model: string;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
}

/** This example's own folder, from src/ (tsx) or dist/src/ (compiled). */
export function exampleRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(dirname(here)) === 'dist' ? dirname(dirname(here)) : dirname(here);
}

function readConfig(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw Error(`Config file not found: ${path}. Create it with: cp config.example.json config.json`);
    throw Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }
}

/** The model ID and its two rates. Adds a problem per field that cannot work for a live run. */
function modelSettings(raw: Record<string, unknown>, problems: string[]): LiveModelConfig {
  const model = typeof raw.model === 'string' ? raw.model : '';
  const rate = (key: 'inputMicrousdPerMillionTokens' | 'outputMicrousdPerMillionTokens') => Number(raw[key]);
  if (!model || model.includes('YOUR_')) problems.push('model: set an OpenAI model ID, for example "gpt-5.6-terra"');
  for (const key of ['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'] as const)
    if (!Number.isSafeInteger(rate(key)) || rate(key) <= 0) problems.push(`${key}: set the model's price in micro-USD per 1M tokens ($1 = 1000000)`);
  return { model, inputMicrousdPerMillionTokens: rate('inputMicrousdPerMillionTokens'), outputMicrousdPerMillionTokens: rate('outputMicrousdPerMillionTokens') };
}

const fail = (path: string, problems: readonly string[]) => {
  if (problems.length) throw Error(`${path}: ${problems.length} problem(s)\n${problems.map(item => `  - ${item}`).join('\n')}`);
};

/** The model and prices the demo uses: from config.example.json, or from the file passed with --config. */
export function loadModelSettings(path: string): LiveModelConfig {
  const problems: string[] = [];
  const settings = modelSettings(readConfig(path), problems);
  fail(path, problems);
  return settings;
}

/**
 * Read and check config.json. Every problem is reported at once; the model key is checked last, and only
 * for a live run, so `--analyze` works without a key or prices.
 */
export function loadConfig(path: string, options: { live: boolean; broad: boolean; exampleRoot?: string }): HandoffConfig {
  const raw = readConfig(path);
  const problems: string[] = [];
  const root = resolve(dirname(path), String(raw.project ?? '.'));
  let files: string[] = [];
  let scripts: Record<string, unknown> = {};
  if (!existsSync(root) || !statSync(root).isDirectory()) problems.push(`project: ${root} is not a directory`);
  else if (!existsSync(join(root, 'package.json'))) problems.push(`project: ${root} has no package.json`);
  else {
    const project = realpathSync(root), example = realpathSync(options.exampleRoot ?? exampleRoot());
    if (example === project || example.startsWith(project + sep))
      problems.push(`project: this example folder is inside the project (${relative(project, example) || '.'}). ` +
        'Move the example outside the project, for example next to it, so the agents and your test runner do not see its files');
    else {
      try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}; }
      catch { problems.push(`project: ${join(root, 'package.json')} is not valid JSON`); }
      try { files = projectFiles(root); } catch (error) { problems.push(`project: ${error instanceof Error ? error.message : 'unreadable'}`); }
    }
  }
  const testScript = String(raw.testScript ?? 'test');
  if (files.length && !Object.hasOwn(scripts, testScript))
    problems.push(`testScript: "${testScript}" is not a script in package.json (scripts: ${Object.keys(scripts).join(', ') || 'none'})`);

  let writable: string[] | undefined;
  if (!options.broad) {
    const listed = raw.coderWritablePaths;
    if (!Array.isArray(listed) || !listed.length || listed.some(item => typeof item !== 'string'))
      problems.push('coderWritablePaths: list the exact files the coder may ever edit, for example ["src/cart.js"], or pass --broad');
    else {
      writable = [...new Set((listed as string[]).map(item => item.replace(/^(\.\/)+/, '')))];
      if (files.length) for (const item of writable) {
        if (/[*?[\]{}]/.test(item)) problems.push(`coderWritablePaths: "${item}" is a pattern; list exact files (no globs)`);
        else if (item.endsWith('/') || (existsSync(join(root, item)) && statSync(join(root, item)).isDirectory()))
          problems.push(`coderWritablePaths: "${item}" is a directory; list the exact files in it`);
        else if (PRIVATE.test(item)) problems.push(`coderWritablePaths: "${item}" is a hidden or key file; agents never see those`);
        else if (!files.includes(item)) {
          const similar = files.filter(file => basename(file) === basename(item));
          problems.push(`coderWritablePaths: "${item}" is not a project file${similar.length ? ` (did you mean ${similar.slice(0, 3).join(', ')}?)` : ''}`);
        }
      }
    }
  }

  // --analyze needs no model or prices, so they are checked only for a live run.
  const settings = modelSettings(raw, options.live ? problems : []);
  if (options.live && !process.env.OPENAI_API_KEY) problems.push('OPENAI_API_KEY is not set on this host (--analyze needs no key)');
  fail(path, problems);
  return { root, files, task: String(raw.task ?? DEFAULT_TASK), testScript, ...(writable ? { writable } : {}), ...settings };
}
