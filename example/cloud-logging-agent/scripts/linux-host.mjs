// Runs a compiled entry point inside the trusted Linux host container (linux-host/Dockerfile),
// for Docker Desktop or Colima on macOS. The runtime then provisions the Codex worker with the
// same Docker daemon, exactly as on a Linux host. Usage: node scripts/linux-host.mjs <entry.js> [args]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw Error('Usage: node scripts/linux-host.mjs <entry.js> [args]');
// Docker resolves bind mounts on its own VM, so the project and credential file use the same path inside and out.
// Docker Desktop and Colima share only your home directory by default; anything else would mount as an empty
// directory created in the VM. Check real paths (for example /tmp is /private/tmp on macOS) before running Docker.
// DOCKER_SHARED_DIRS (colon-separated) lists directories you added to Docker's file sharing yourself.
const home = realpathSync(homedir());
const roots = [home, ...(process.env.DOCKER_SHARED_DIRS ?? '').split(':').filter(path => isAbsolute(path) && existsSync(path)).map(path => realpathSync(path))];
const shared = (path, what) => {
  const real = realpathSync(path);
  if (roots.some(root => real === root || real.startsWith(root + sep))) return real;
  console.error(`${what} ${real} is outside your home directory. Docker Desktop and Colima share only your home directory with their VM ` +
    `by default: move it under ${home}, or add its directory to Docker's file sharing and to DOCKER_SHARED_DIRS.`);
  process.exit(1);
};
const dir = shared(process.cwd(), 'The project directory');
const adc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (adc && (!isAbsolute(adc) || !existsSync(adc))) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS must be an absolute path to an existing file');
  process.exit(1);
}
const adcSource = adc && shared(adc, 'GOOGLE_APPLICATION_CREDENTIALS');
// A dependency installed as a link (the runtime is "file:../.." inside its own repository) resolves outside the
// project directory. Mount each linked package's real path read-only at the same path so Node resolves it there too.
const modules = join(dir, 'node_modules');
const packages = existsSync(modules) ? readdirSync(modules).filter(name => !name.startsWith('.'))
  .flatMap(name => name.startsWith('@') ? readdirSync(join(modules, name)).map(child => join(name, child)) : [name]) : [];
const within = (path, root) => path === root || path.startsWith(root + sep);
const linked = [...new Set(packages.filter(name => lstatSync(join(modules, name)).isSymbolicLink())
  .map(name => shared(join(modules, name), `The linked dependency ${name} at`)))]
  .filter((path, _, all) => !within(path, dir) && !all.some(other => other !== path && within(path, other)));
const dockerfile = join(dir, 'linux-host', 'Dockerfile');
const image = `cloud-logging-linux-host:${createHash('sha256').update(readFileSync(dockerfile)).digest('hex').slice(0, 12)}`;
const run = (command, argv, options = {}) => execFileSync(command, argv, { stdio: 'inherit', ...options });

run('npm', ['run', 'build']);
try { execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }); }
catch { console.log(`Building ${image} (first run only)...`); run('docker', ['build', '--quiet', '--tag', image, join(dir, 'linux-host')]); }

// --mount fails on a missing source instead of creating an empty directory in Docker's VM. Fields are CSV-quoted.
const bind = (source, target) => `type=bind,"source=${source.replaceAll('"', '""')}","target=${target.replaceAll('"', '""')}"`;
const tmp = join(dir, '.linux-host-tmp');
mkdirSync(tmp, { recursive: true });
const docker = ['run', '--rm', '--network', 'host', '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW',
  '--volume', '/var/run/docker.sock:/var/run/docker.sock', '--mount', bind(dir, dir), '--workdir', dir, '--env', `TMPDIR=${tmp}`];
// Docker mounts parents before children, so a linked package that contains the project stays read-only around it.
for (const path of linked) docker.push('--mount', `${bind(path, path)},readonly`);
// Pass secrets by name only, so their values never appear in a command line.
for (const name of ['OPENAI_API_KEY']) if (process.env[name]) docker.push('--env', name);
if (adc) docker.push('--mount', `${bind(adcSource, adc)},readonly`, '--env', 'GOOGLE_APPLICATION_CREDENTIALS');
try { run('docker', [...docker, image, 'node', entry, ...args]); }
catch (error) { process.exitCode = typeof error.status === 'number' ? error.status : 1; }
finally { rmSync(tmp, { recursive: true, force: true }); }
