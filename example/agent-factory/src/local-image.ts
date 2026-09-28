import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkStore } from './store.js';

const recipeDirectory = fileURLToPath(new URL('../images/linux-arm64/', import.meta.url));
const zotVersion = '2.1.21';
const zotSha256 = 'd885297d2d386a8a7347cffc5ae712088893b06dc5c09a4fb6c9faaed38c4666';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const environment = () => Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
interface Store { schemaVersion: 1; port: number }
interface Image { schemaVersion: 1; recipeDigest: string; image: string }
export interface LocalImageDrivers {
  installBinary(directory: string): Promise<string>;
  startRegistry(binary: string, directory: string, port: number): Promise<() => Promise<void>>;
  build(recipe: string, state: string, destination: string): Promise<void>;
}
export interface LocalImageHandle { image: string; close(): Promise<void> }

async function run(binary: string, args: string[]) {
  const child = spawn(binary, args, { stdio: 'inherit', env: environment() });
  const status = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  if (status !== 0) throw Error(`${binary} did not complete; inspect the image build logs`);
}
async function availablePort(port = 0): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Could not allocate local image-store port');
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}
function save(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function workerRecipeDigest(directory = recipeDirectory): string {
  const digest = createHash('sha256');
  for (const name of ['versions.json', 'build.sh', 'provision.sh', 'seal.sh']) {
    digest.update(name + '\0').update(readFileSync(join(directory, name))).update('\0');
  }
  return digest.digest('hex');
}

const registryGuard = `
const {spawn}=require('node:child_process');
const stop=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}};
process.once('disconnect',stop);
process.once('message',({binary,config})=>{
 if(!process.connected)return stop();
 const child=spawn(binary,['serve',config],{stdio:'inherit'});
 child.once('error',stop);child.once('close',stop);
});
`;
export const localImageDrivers: LocalImageDrivers = {
  async installBinary(directory) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Local image preparation requires Apple Silicon macOS');
    const binary = join(directory, `zot-${zotVersion}`);
    if (!existsSync(binary)) {
      const pending = binary + '.' + randomUUID() + '.download';
      try {
        await run('curl', ['--fail', '--location', '--retry', '3', '--proto', '=https', '--proto-redir', '=https',
          `https://github.com/project-zot/zot/releases/download/v${zotVersion}/zot-darwin-arm64-minimal`, '--output', pending]);
        if (hash(readFileSync(pending)) !== zotSha256) throw Error('Local image-store download checksum mismatch');
        chmodSync(pending, 0o700); renameSync(pending, binary);
      } finally { rmSync(pending, { force: true }); }
    }
    if (hash(readFileSync(binary)) !== zotSha256) throw Error('Local image-store binary changed');
    return binary;
  },
  async startRegistry(binary, directory, port) {
    // Never adopt a service already occupying the saved port.
    await availablePort(port);
    const config = join(directory, 'registry.json');
    save(config, { distSpecVersion: '1.1.1', storage: { rootDirectory: join(directory, 'data'), gc: false },
      http: { address: '127.0.0.1', port: String(port) }, log: { level: 'error' } });
    const log = openSync(join(directory, 'registry.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['-e', registryGuard], { detached: true, env: environment(), stdio: ['ignore', log, log, 'ipc'] });
    closeSync(log);
    let ended = false;
    const closed = new Promise<void>(accept => { child.once('error', () => { ended = true; accept(); }); child.once('exit', () => { ended = true; accept(); }); });
    const stop = async () => { if (child.connected) child.disconnect(); await closed; };
    try {
      await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
      child.send({ binary, config });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (ended) throw Error('Local image store stopped; inspect image-store/registry.log');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v2/`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) });
          if (response.ok) return stop;
        } catch { /* Wait for this owned child to bind. */ }
        await new Promise(accept => setTimeout(accept, 100));
      }
      throw Error('Local image store did not become ready');
    } catch (error) { await stop(); throw error; }
  },
  async build(recipe, state, destination) { await run('/bin/bash', [join(recipe, 'build.sh'), state, destination]); },
};

/** The factory prepares its own image; runtime still receives an immutable OCI reference. */
export async function openLocalImage(directory: string, options: {
  prepare?: boolean; recipeDirectory?: string; drivers?: LocalImageDrivers;
} = {}): Promise<LocalImageHandle | undefined> {
  const root = resolve(directory, 'image-store');
  if (!options.prepare && !existsSync(join(root, 'store.json'))) return undefined; // Explicit externally supplied image installations.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw Error('Local image directory must be canonical');
  const lock = new WorkStore(join(root, 'lock.sqlite'));
  let owner: string | undefined; let stop: (() => Promise<void>) | undefined; let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await stop?.(); } finally {
      try { if (owner) lock.releaseController('local-image', owner); } finally { lock.close(); }
    }
  };
  try {
    owner = lock.acquireController('local-image');
    const path = join(root, 'store.json');
    const store: Store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, port: await availablePort() };
    if (store.schemaVersion !== 1 || !Number.isSafeInteger(store.port) || store.port < 1024 || store.port > 65535) throw Error('Invalid local image-store configuration');
    if (!existsSync(path)) save(path, store);
    const recipe = options.recipeDirectory ?? recipeDirectory;
    const recipeDigest = workerRecipeDigest(recipe);
    const imagePath = join(root, 'image.json');
    let image: Image | undefined = existsSync(imagePath) ? JSON.parse(readFileSync(imagePath, 'utf8')) : undefined;
    if (image && (image.schemaVersion !== 1 || image.recipeDigest !== recipeDigest)) throw Error('Image recipe changed; use a new installation directory to prepare and review the new image');
    if (!image && !options.prepare) throw Error('Run the wizard to finish preparing the local image');
    const drivers = options.drivers ?? localImageDrivers;
    const binary = await drivers.installBinary(root);
    stop = await drivers.startRegistry(binary, root, store.port);
    const prefix = `127.0.0.1:${store.port}/factory/worker`;
    if (image && !new RegExp('^' + prefix.replaceAll('.', '\\.') + '@sha256:[a-f0-9]{64}$').test(image.image)) throw Error('Invalid local image reference');
    if (!image) {
      console.log('Preparing the worker image from the repository recipe. This first build can take several minutes.');
      const tag = 'recipe-' + recipeDigest;
      await drivers.build(recipe, join(root, 'build-' + randomUUID()), prefix + ':' + tag);
      const response = await fetch(`http://127.0.0.1:${store.port}/v2/factory/worker/manifests/${tag}`, { headers: { accept: 'application/vnd.oci.image.manifest.v1+json', connection: 'close' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw Error('Prepared image manifest is unavailable');
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = 'sha256:' + hash(bytes);
      if (response.headers.get('docker-content-digest') !== digest) throw Error('Prepared image manifest digest mismatch');
      image = { schemaVersion: 1, recipeDigest, image: prefix + '@' + digest }; save(imagePath, image);
    }
    const digest = image.image.split('@')[1]!;
    const response = await fetch(`http://127.0.0.1:${store.port}/v2/factory/worker/manifests/${digest}`, { headers: { accept: 'application/vnd.oci.image.manifest.v1+json', connection: 'close' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok || 'sha256:' + hash(Buffer.from(await response.arrayBuffer())) !== digest) throw Error('Cached worker image is missing or changed; restore the image store');
    return { image: image.image, close };
  } catch (error) { await close(); throw error; }
}
