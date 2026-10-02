import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Where this machine keeps an organization's onboarding records: `~/.config/software-factory/<org>`. A machine that
 * onboarded under the product's earlier name keeps using `~/.config/agent-factory/<org>` in place, so an existing hub
 * resumes from its own records. Nothing there is moved, rewritten or deleted.
 */
export function connectionDirectory(home: string, organization: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(organization)) throw Error('Invalid organization');
  const current = join(home, '.config', 'software-factory', organization);
  const earlier = join(home, '.config', 'agent-factory', organization);
  return !existsSync(current) && existsSync(earlier) ? earlier : current;
}

export function recoverConnectionLock(directory: string): void {
  const root = resolve(directory);
  const parent = lstatSync(root);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) || realpathSync(root) !== root) throw Error('Unsafe connection directory');
  const path = join(root, 'onboarding.lock');
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096) throw Error('Unsafe connection lock');
  const bytes = readFileSync(path, 'utf8');
  let record: { schemaVersion?: number; owner?: string; pid?: number; host?: string };
  try { record = JSON.parse(bytes); } catch { throw Error('Legacy or incomplete lock requires operator reconciliation'); }
  if (record.schemaVersion !== 1 || record.host !== hostname() || !Number.isSafeInteger(record.pid) || record.pid! < 1 ||
    !/^[a-f0-9-]{36}$/.test(record.owner ?? '')) throw Error('Unverified lock identity');
  try { process.kill(record.pid!, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      const current = lstatSync(path);
      if (current.ino !== stat.ino || current.dev !== stat.dev || readFileSync(path, 'utf8') !== bytes) throw Error('Connection lock changed during recovery');
      unlinkSync(path);
      return;
    }
  }
  throw Error(`Onboarding lock owner (process ${record.pid}) may still be alive; recovery refused`);
}

export interface FactoryConnection {
  schemaVersion: 1;
  organization: string;
  repositories: Array<{ name: string; id: number }>;
  /** Chosen after installation, when the destination repositories are known. */
  secretScope?: 'organization' | 'repository';
  phase: 'preflight' | 'creation-started' | 'app-created' | 'credentials-stored' | 'connected';
  appId?: number;
  appSlug?: string;
  privateKeySecret?: string;
  installationId?: number;
}
function data(input: FactoryConnection): FactoryConnection {
  if (input.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(input.organization) ||
    !['preflight', 'creation-started', 'app-created', 'credentials-stored', 'connected'].includes(input.phase) ||
    (input.secretScope !== undefined && !['organization', 'repository'].includes(input.secretScope)) ||
    // Destinations come from the App installation, so they are known only once credentials are stored.
    (['credentials-stored', 'connected'].includes(input.phase) && (input.secretScope === undefined || !input.repositories?.length)) ||
    !Array.isArray(input.repositories) || input.repositories.length > 100 ||
    input.repositories.some(repo => !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repo.name) ||
      repo.name.split('/')[0]!.toLowerCase() !== input.organization.toLowerCase() || !Number.isSafeInteger(repo.id) || repo.id < 1)) throw Error('Invalid connection record');
  if (!['preflight', 'creation-started'].includes(input.phase) && (!Number.isSafeInteger(input.appId) || input.appId! < 1 ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.appSlug ?? '') || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(input.privateKeySecret ?? ''))) throw Error('Incomplete App record');
  if (input.phase === 'connected' && (!Number.isSafeInteger(input.installationId) || input.installationId! < 1)) throw Error('Incomplete installation record');
  // Copy only non-secret fields. Never serialize opaque provider responses.
  return { schemaVersion: 1, organization: input.organization, repositories: input.repositories.map(repo => ({ name: repo.name, id: repo.id })),
    ...(input.secretScope === undefined ? {} : { secretScope: input.secretScope }), phase: input.phase,
    ...(input.appId === undefined ? {} : { appId: input.appId }), ...(input.appSlug === undefined ? {} : { appSlug: input.appSlug }),
    ...(input.privateKeySecret === undefined ? {} : { privateKeySecret: input.privateKeySecret }),
    ...(input.installationId === undefined ? {} : { installationId: input.installationId }) };
}

export function openConnectionStore(directory: string) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || realpathSync(root) !== root) throw Error('Connection directory must be private, owned, and canonical');
  const lockPath = join(root, 'onboarding.lock');
  const owner = randomUUID();
  const lockRecord = JSON.stringify({ schemaVersion: 1, owner, pid: process.pid, host: hostname() });
  const createLock = () => openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let lock: number;
  try { lock = createLock(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A lock whose process is proven gone is removed; a live or unverifiable owner is explained, never overridden.
    try { recoverConnectionLock(root); }
    catch (reason) {
      const message = (reason as Error).message;
      const pid = /process (\d+)/.exec(message)?.[1];
      throw Error(pid
        ? `Another Software Factory onboarding for this organization is still running (process ${pid}). Finish it or stop it with Ctrl+C in its terminal; a run paused with Ctrl+Z still counts, so resume it with fg first. Then rerun.`
        : `An earlier onboarding left ${lockPath} and it cannot be verified (${message}). Make sure no onboarding is running, delete that file, then rerun.`);
    }
    lock = createLock();
  }
  try { writeFileSync(lock, lockRecord); fsyncSync(lock); } finally { closeSync(lock); }
  const path = join(root, 'connection.json');
  return {
    /** The locked, private directory; other records for this organization live beside connection.json. */
    directory: root,
    load(): FactoryConnection | undefined {
      if (!existsSync(path)) return undefined;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 32768) throw Error('Unsafe connection record');
      return data(JSON.parse(readFileSync(path, 'utf8')));
    },
    save(connection: FactoryConnection): void {
      const serialized = JSON.stringify(data(connection), null, 2) + '\n';
      const temporary = join(root, `connection-${owner}.pending`);
      const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(descriptor, serialized); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path);
    },
    /** Forget an interrupted connection after the caller has resolved its GitHub side. */
    reset(): void {
      if (existsSync(path)) unlinkSync(path);
    },
    close(): void {
      if (readFileSync(lockPath, 'utf8') !== lockRecord) throw Error('Connection lock ownership changed');
      unlinkSync(lockPath);
    },
  };
}
