import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const collect = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? collect(path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
});
const tests = collect(join(root, 'test')).sort();
if (!tests.length) throw Error('No runtime tests found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
