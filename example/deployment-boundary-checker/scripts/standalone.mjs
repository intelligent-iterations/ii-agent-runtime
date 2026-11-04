// npm run test:package: the path a newcomer takes when they copy this folder into their own repository.
// It packs the runtime this example depends on, copies the example outside the repository, installs the
// runtime from that tarball, and runs the checks, the demo against recorded GitHub responses (npm run test:demo),
// the build and the compiled CLI in the copy. It needs no network for the checker and no GitHub token.
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
// The compiled CLI reads GitHub through the tests' recorded responses, so a placeholder token is enough.
const recorded = { ...env, GITHUB_TOKEN: 'recorded-responses-need-no-token' };
delete recorded.GITHUB_RECORD;
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
  // The demo itself reads a real repository on GitHub; test:demo runs the same command against recorded responses.
  for (const args of [['run', 'check'], ['run', 'test:demo'], ['run', 'build']]) run('npm', args, destination);
  run('node', ['dist/src/cli.js', '--help'], destination);
  const compiled = (...grants) => spawnSync('node', ['--import', './test/recorded-github.mjs', 'dist/src/cli.js', ...grants, '--github'],
    { cwd: destination, env: recorded, encoding: 'utf8', timeout: 120000 });
  const comparison = compiled('--grants', 'dist/agents/broad.js', '--compare', 'dist/agents/restricted.js');
  assert.equal(comparison.status, 0, comparison.stderr);
  assert.match(comparison.stdout, /Narrowing the grants changed the result: FINDING -> CLEAR\./);
  assert.doesNotMatch(comparison.stderr, /Refused/);
  assert.equal(compiled('--grants', 'dist/agents/broad.js').status, 1, 'A found path exits 1');
  console.log('Copied example with the packed runtime: install, checks, recorded demo, build, CLI help and compiled comparison passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
