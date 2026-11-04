// npm run test:package: the path a newcomer takes when they copy this folder next to their own project.
// It packs the runtime this example depends on, copies the example outside the repository, installs the
// runtime from that tarball, and runs the checks, build, CLI and compiled demo in the copy.
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const runtimeName = '@intelligent-iterations/ii-agent-runtime';
const example = fileURLToPath(new URL('../', import.meta.url));
// If npm needs Git, it never reads the system Git config or asks a credential helper (no keychain prompts).
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit', timeout: 600000 });
// Build output, installed packages and local settings stay behind, as in a fresh copy.
const local = new Set(['node_modules', 'dist', 'config.json', '.env']);
const copied = path => { const parts = relative(example, path).split(sep); return !local.has(parts[0]) && !parts.includes('node_modules'); };

// Inside this repository the dependency is file:../.. (the checkout itself); in your own copy it is the GitHub repository.
const spec = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')).dependencies[runtimeName];
const runtime = spec.startsWith('file:') ? resolve(example, spec.slice('file:'.length)) : undefined;
if (runtime && !existsSync(join(runtime, 'node_modules'))) {
  console.error(`Run npm ci in ${runtime} first: it installs and builds the runtime this example uses.`);
  process.exit(1);
}
const temp = mkdtempSync(join(tmpdir(), 'subagent-handoff-standalone-'));
try {
  const destination = join(temp, 'subagent-handoff');
  cpSync(example, destination, { recursive: true, filter: copied });
  for (const name of readdirSync(join(destination, 'src'))) {
    const source = readFileSync(join(destination, 'src', name), 'utf8');
    assert.ok(!/from ['"](?:\.\.\/){2}|ii-agent-runtime\/src/.test(source), 'example must consume installed exports only');
  }
  if (runtime) {
    // Build the runtime and install it as the packed package, not as a link into this repository.
    run('npm', ['run', 'build'], runtime);
    const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
      { cwd: runtime, env, encoding: 'utf8' }));
    run('npm', ['install', '--no-audit', '--no-fund', join(temp, filename)], destination);
  } else run('npm', ['ci', '--no-audit', '--no-fund'], destination);
  assert.ok(!lstatSync(join(destination, 'node_modules', runtimeName)).isSymbolicLink(), 'the copy must use an installed runtime, not a link');
  for (const args of [['run', 'check'], ['run', 'build']]) run('npm', args, destination);
  run('node', ['dist/src/cli.js', '--help'], destination);
  const demo = execFileSync('npm', ['run', 'demo'], { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.match(demo, /The handoff still fixed the test \(exit 0\)/);
  const compiled = execFileSync('node', ['dist/src/cli.js', '--demo'], { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.match(compiled, /The handoff still fixed the test \(exit 0\)/);
  console.log('Copied example with the packed runtime: install, checks, build, CLI help, demo and compiled demo passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
