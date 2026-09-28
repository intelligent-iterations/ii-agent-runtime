import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, rmSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { executeTartGuest } from './tart.js';
import { durableWrite } from './workspace.js';

export interface CapturedFile { path: string; size: number; sha256: string; localPath: string }
export interface CaptureOptions { root: string; paths: string[]; destination: string; maxBytes?: number; optionalPaths?: string[] }
export type GuestCommand = (manifestPath: string, command: string[], input?: string | Uint8Array) => Promise<string>;
// Open every path component without following symlinks. Only regular, singly-linked files are readable.
const reader = `import os, sys, json, stat, hashlib, base64
request=json.load(sys.stdin)
parts=request['root'].split('/')+request['path'].split('/')
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
    for part in [p for p in parts if p][:-1]:
        if part in ('.','..'): raise ValueError('path')
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
        os.close(fd);fd=child
    name=[p for p in parts if p][-1]
    if name in ('.','..'): raise ValueError('path')
    file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
except FileNotFoundError:
    print(json.dumps({'missing':True}));sys.exit(0)
finally: os.close(fd)
try:
    before=os.fstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>request['maxBytes']: raise ValueError('file')
    if request['action']=='describe':
        digest=hashlib.sha256()
        while True:
            chunk=os.read(file,262144)
            if not chunk: break
            digest.update(chunk)
        result={'size':before.st_size,'sha256':digest.hexdigest()}
    else:
        os.lseek(file,request['offset'],os.SEEK_SET)
        result={'data':base64.b64encode(os.read(file,request['length'])).decode('ascii')}
    after=os.fstat(file)
    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ValueError('changed')
    print(json.dumps(result))
finally: os.close(file)
`;

/** Copies bounded declared files to consumer-owned storage and verifies their actual retained bytes. */
export async function captureGuestFiles(manifestPath: string, options: CaptureOptions, execute: GuestCommand): Promise<CapturedFile[]> {
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
  if (!isAbsolute(options.root) || options.root.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(limit) || limit < 1) throw Error('Invalid capture root or limit');
  if (!options.paths.length || new Set(options.paths).size !== options.paths.length || options.paths.some(path =>
    !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..'))) throw Error('Invalid capture paths');
  const optional = new Set(options.optionalPaths ?? []);
  if (optional.size !== (options.optionalPaths ?? []).length || [...optional].some(path => !options.paths.includes(path))) throw Error('Optional paths must be unique requested paths');
  const missing: string[] = [];
  const sensitivePath = /(^|\/)(\.env[^/]*|\.ssh|\.aws|\.codex|auth\.json|credentials[^/]*|[^/]+\.(pem|key))(\/|$)/i;
  if (options.paths.some(path => sensitivePath.test(options.root + '/' + path))) throw Error('Credential paths are not capture outputs');
  const destination = realpathSync(options.destination);
  const result: CapturedFile[] = [];
  let remaining = limit;
  for (const path of options.paths) {
    const query = async (action: string, extra = {}) => JSON.parse(await execute(manifestPath, ['sudo', '-n', 'python3', '-c', reader],
      JSON.stringify({ action, root: options.root, path, maxBytes: remaining, ...extra }))) as Record<string, unknown>;
    const metadata = await query('describe');
    if (metadata.missing === true && optional.has(path)) { missing.push(path); continue; }
    if (!Number.isSafeInteger(metadata.size) || (metadata.size as number) < 0 || (metadata.size as number) > remaining ||
        typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw Error('Invalid capture metadata');
    const size = metadata.size as number;
    const temporary = join(destination, `.capture-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    const digest = createHash('sha256');
    let verified = false;
    try {
      for (let offset = 0; offset < size;) {
        const length = Math.min(262144, size - offset);
        const response = await query('read', { offset, length });
        if (typeof response.data !== 'string') throw Error('Invalid capture bytes');
        const bytes = Buffer.from(response.data, 'base64');
        if (bytes.length !== length || bytes.toString('base64') !== response.data) throw Error('Invalid capture chunk');
        digest.update(bytes);
        let written = 0;
        while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
        offset += bytes.length;
      }
      if (digest.digest('hex') !== metadata.sha256) throw Error('Captured file changed or was corrupted');
      const final = await query('describe');
      if (final.size !== size || final.sha256 !== metadata.sha256) throw Error('Source changed during capture');
      fsyncSync(fd);
      verified = true;
    } finally { closeSync(fd); if (!verified) rmSync(temporary, { force: true }); }
    // Unique names avoid letting guest paths choose host paths or replace existing evidence.
    const localPath = join(destination, `file-${randomUUID()}`);
    renameSync(temporary, localPath);
    const directory = openSync(dirname(localPath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    result.push({ path, size, sha256: metadata.sha256, localPath });
    remaining -= size;
  }
  durableWrite(join(destination, `capture-${randomUUID()}.json`), { schemaVersion: 1, files: result, missing });
  return result;
}

export function captureTartFiles(manifestPath: string, options: CaptureOptions, execute = executeTartGuest): Promise<CapturedFile[]> {
  return captureGuestFiles(manifestPath, options, execute);
}
