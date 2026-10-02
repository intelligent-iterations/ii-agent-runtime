import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfiguration } from '../runtime/configuration-types.js';

export interface SetupPlan { label: string; commands: string[]; timeoutMs: number }

// Lockfile-driven installs only: each reproduces exactly what the repository pins, without upgrading anything.
const DETECTED: Array<{ file: string; label: string; commands: string[] }> = [
  { file: 'pnpm-lock.yaml', label: 'pnpm install', commands: ['corepack pnpm install --frozen-lockfile'] },
  { file: 'yarn.lock', label: 'yarn install', commands: ['corepack yarn install --immutable'] },
  { file: 'package-lock.json', label: 'npm ci', commands: ['npm ci --no-audit --no-fund'] },
  { file: 'requirements.txt', label: 'pip install', commands: ['python3 -m venv .venv', '.venv/bin/pip install --no-input -r requirements.txt'] },
];
export const DEFAULT_SETUP_MINUTES = 10;

/**
 * What to install before the agent starts. Configured commands win; otherwise the repository's lockfiles decide, so a
 * repository without one gets no setup. Only the presence of files at the repository root is read, never their content.
 */
export function planSetup(environment: RuntimeConfiguration['environment'], directory: string): SetupPlan | undefined {
  const setup = environment.setup;
  if (setup?.enabled === false) return undefined;
  const timeoutMs = (setup?.timeoutMinutes ?? DEFAULT_SETUP_MINUTES) * 60000;
  if (setup?.commands?.length) return { label: setup.commands.join(' && ').slice(0, 120), commands: setup.commands, timeoutMs };
  const found = DETECTED.filter(entry => existsSync(join(directory, entry.file)));
  // One JavaScript package manager: the most specific lockfile wins. Python installs alongside it.
  const javascript = found.find(entry => entry.file !== 'requirements.txt');
  const python = found.find(entry => entry.file === 'requirements.txt');
  const chosen = [javascript, python].filter((entry): entry is (typeof DETECTED)[number] => entry !== undefined);
  if (!chosen.length) return undefined;
  return { label: chosen.map(entry => entry.label).join(' + '), commands: chosen.flatMap(entry => entry.commands), timeoutMs };
}
