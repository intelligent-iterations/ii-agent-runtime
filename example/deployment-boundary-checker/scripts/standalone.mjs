// npm run test:package: the path a newcomer takes when they copy this folder into their own repository.
// It packs the runtime this example depends on, copies the example outside the repository, installs the
// runtime from that tarball, and runs the checks, demo, build and compiled CLI in the copy.
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const runtimeName = '@intelligent-iterations/ii-agent-runtime';
const example = fileURLToPath(new URL('../', import.meta.url));
// If npm needs Git, it never reads the system Git config or asks a credential helper (no keychain prompts).
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit', timeout: 600000 });
// Build output, installed packages, local settings and test leftovers stay behind, as in a fresh copy.
const local = new Set(['node_modules', 'dist', '.env']);
const copied = path => {
  const parts = relative(example, path).split(sep);
  return !local.has(parts[0]) && !parts.includes('node_modules') && !parts.some(part => part.startsWith('.grants-'));
};

// Inside this repository the dependency is file:../.. (the checkout itself); in your own copy it is the GitHub repository.
const spec = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')).dependencies[runtimeName];
const runtime = spec.startsWith('file:') ? resolve(example, spec.slice('file:'.length)) : undefined;
if (runtime && !existsSync(join(runtime, 'node_modules'))) {
  console.error(`Run npm ci in ${runtime} first: it installs and builds the runtime this example uses.`);
  process.exit(1);
}
const temp = mkdtempSync(join(tmpdir(), 'deployment-boundary-standalone-'));
try {
  const destination = join(temp, 'deployment-boundary-checker');
  cpSync(example, destination, { recursive: true, filter: copied });
  for (const directory of ['src', 'agents', 'scripts', 'test']) for (const name of readdirSync(join(destination, directory))) {
    const source = readFileSync(join(destination, directory, name), 'utf8');
    assert.ok(!/from ['"](?:\.\.\/){2,}|ii-agent-runtime\/src/.test(source), `${directory}/${name} must use installed runtime exports only`);
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
  // The README's first run needs nothing beyond the install.
  const demo = spawnSync('npm', ['run', 'demo'], { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Narrowing the grants changed the result: FINDING -> CLEAR\./);
  run('node', ['dist/src/cli.js', '--help'], destination);
  const compiled = spawnSync('node', ['dist/src/cli.js', '--grants', 'dist/agents/broad.js', '--compare', 'dist/agents/restricted.js',
    '--workflows', 'fixtures/functions/workflows'], { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.match(compiled.stdout, /Narrowing the grants changed the result: FINDING -> CLEAR\./);
  const broad = spawnSync('node', ['dist/src/cli.js', '--grants', 'dist/agents/broad.js', '--workflows', 'fixtures/functions/workflows'],
    { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(broad.status, 1, 'A found path exits 1');
  console.log('Copied example with the packed runtime: install, checks, demo, build, CLI help and compiled comparison passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
