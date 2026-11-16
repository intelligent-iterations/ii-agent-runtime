// Verify a copied example against the packed, installed runtime. No model account is required.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {bindRuntime} from './packaging.mjs';

const runtimeName = '@intelligent-iterations/ii-agent-runtime';
const example = fileURLToPath(new URL('../', import.meta.url));
// If npm needs Git, it never reads the system Git config or asks a credential helper (no keychain prompts).
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
delete env.OPENAI_API_KEY;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit', timeout: 600000 });
// Build output, installed packages and local settings stay behind, as in a fresh copy.
const local = new Set(['node_modules', 'dist', 'config.json', '.env', 'results', '.runtime']);
const copied = path => { const parts = relative(example, path).split(sep); return !local.has(parts[0]) && !parts.includes('node_modules') && !parts.includes('results'); };

// Inside this repository the dependency is file:../.. (the checkout itself); in your own copy it is the packed runtime.
const spec = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')).dependencies[runtimeName];
const candidate = spec.startsWith('file:') ? resolve(example, spec.slice('file:'.length)) : undefined;
const runtime = candidate && existsSync(candidate) && lstatSync(candidate).isDirectory() ? candidate : undefined;
if (runtime && !existsSync(join(runtime, 'node_modules'))) {
  console.error(`Run npm ci in ${runtime} first: it installs and builds the runtime this example uses.`);
  process.exit(1);
}
const temp = mkdtempSync(join(tmpdir(), 'video-editing-standalone-'));
try {
  env.HOME = join(temp, 'home');
  env.npm_config_cache = join(temp, 'npm-cache');
  mkdirSync(env.HOME);
  const destination = join(temp, 'video-editing');
  cpSync(example, destination, { recursive: true, filter: copied });
  for (const name of readdirSync(join(destination, 'src')).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(join(destination, 'src', name), 'utf8');
    assert.ok(!/ii-agent-runtime\/src/.test(source), 'consume installed exports only');
  }
  if (runtime) {
    // Build the runtime and install it as the packed package, not as a link into this repository.
    run('npm', ['run', 'build'], runtime);
    const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
      { cwd: runtime, env, encoding: 'utf8' }));
    bindRuntime(destination,'file:'+join(temp, filename));
    run('npm', ['install', '--no-audit', '--no-fund'], destination);
  } else run('npm', ['ci', '--no-audit', '--no-fund'], destination);
  assert.ok(!lstatSync(join(destination, 'node_modules', runtimeName)).isSymbolicLink(), 'the copy must use an installed runtime, not a link');
  for (const args of [['run', 'check'], ['run', 'build']]) run('npm', args, destination);
  const output = args => execFileSync('node', args, { cwd: destination, env, encoding: 'utf8', timeout: 120000 });
  assert.match(output(['dist/src/cli.js', '--help']), /npm run demo/);
  assert.match(output(['dist/src/demo.js', '--help']), /npm run demo -- --editor remotion/);
  run('node', ['--test', 'dist/test/demo.test.js', 'dist/test/launcher.test.js'], destination);
  const missing = spawnSync('node', ['dist/src/cli.js', '--config', 'missing.json'], {cwd:destination,env,encoding:'utf8'});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /config: supply a readable JSON file/);
  assert.ok(!missing.stderr.includes(' at '));
  // The installed copy runs this same check on itself: it must also work without the repository.
  if (runtime) run('node', ['scripts/standalone.mjs'], destination);
  console.log(runtime ? 'Copied example (packed runtime): install, check, build, compiled CLIs and demo tests passed.'
    : 'Installed copy (no repository): install, check, build, compiled CLIs and demo tests passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
