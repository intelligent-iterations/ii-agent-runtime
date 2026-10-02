import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hubLayout, type HubLayoutName } from './identity.js';

/**
 * Hub onboarding progress, saved after every step so an interrupted run resumes. Only identifiers are stored; the App
 * key goes to the hub the moment the App exists and is never written here.
 */
export interface HubConnection {
  schemaVersion: 2;
  organization: string;
  phase: 'started' | 'hub-ready' | 'app-creation-started' | 'app-created' | 'app-stored' | 'connected';
  /**
   * The hub's durable names (see identity.ts). Records written before layouts existed have none; every one of them
   * belongs to a hub made under the earlier name, so they are read as legacy.
   */
  layout: HubLayoutName;
  hub?: { repository: string; id: number; branch: string };
  app?: { id: number; slug: string; installationId?: number };
  /** A trigger App made by an earlier build, reported so the user can delete it. */
  legacyTrigger?: { id: number; slug: string };
}
const phases: HubConnection['phase'][] = ['started', 'hub-ready', 'app-creation-started', 'app-created', 'app-stored', 'connected'];
/** Phases written by the build that also created a trigger App; all of them had the main App's key stored in the hub. */
const earlierPhases = ['app-installed', 'trigger-creation-started', 'trigger-created', 'trigger-installed'];
export const reached = (connection: HubConnection, phase: HubConnection['phase']) => phases.indexOf(connection.phase) >= phases.indexOf(phase);

const id = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const app = (value: { id: number; slug: string; installationId?: number } | undefined) => value === undefined ||
  (id(value.id) && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value.slug) && (value.installationId === undefined || id(value.installationId)));
function validate(raw: Record<string, any>): HubConnection {
  const phase = earlierPhases.includes(raw.phase) || (raw.phase === 'connected' && raw.trigger) ? 'app-stored' : raw.phase;
  const input: HubConnection = { schemaVersion: raw.schemaVersion, organization: raw.organization, phase, layout: hubLayout(raw.layout ?? 'legacy').name,
    ...(raw.hub ? { hub: raw.hub } : {}), ...(raw.app ? { app: raw.app } : {}),
    ...(raw.legacyTrigger ?? raw.trigger ? { legacyTrigger: { id: (raw.legacyTrigger ?? raw.trigger).id, slug: (raw.legacyTrigger ?? raw.trigger).slug } } : {}) };
  const org = input.organization;
  if (input.schemaVersion !== 2 || !/^[a-z0-9][a-z0-9-]*$/.test(org ?? '') || !phases.includes(input.phase) ||
    (input.hub !== undefined && (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/.test(input.hub.repository) || input.hub.repository.split('/')[0] !== org ||
      !id(input.hub.id) || !/^[A-Za-z0-9._][A-Za-z0-9._\/-]{0,99}$/.test(input.hub.branch))) ||
    !app(input.app) || !app(input.legacyTrigger) || (reached(input, 'hub-ready') && !input.hub) || (reached(input, 'app-created') && !input.app) ||
    (input.phase === 'connected' && !input.app?.installationId)) throw Error('Invalid hub connection record');
  return { schemaVersion: 2, organization: org, phase: input.phase, layout: input.layout, ...(input.hub ? { hub: { ...input.hub } } : {}),
    ...(input.app ? { app: { id: input.app.id, slug: input.app.slug, ...(input.app.installationId ? { installationId: input.app.installationId } : {}) } } : {}),
    ...(input.legacyTrigger ? { legacyTrigger: { id: input.legacyTrigger.id, slug: input.legacyTrigger.slug } } : {}) };
}

function writePrivate(directory: string, name: string, content: string): void {
  const temporary = join(directory, `${name}-${randomUUID()}.pending`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, join(directory, name));
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  const folder = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(folder); } finally { closeSync(folder); }
}
function readPrivate(directory: string, name: string, limit: number): string | undefined {
  const path = join(directory, name);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > limit) throw Error(`Unsafe ${name}`);
  return readFileSync(path, 'utf8');
}

/** Use only while holding the organization's onboarding lock (see openConnectionStore). */
export function hubRecords(directory: string) {
  return {
    load(): HubConnection | undefined {
      const text = readPrivate(directory, 'hub-connection.json', 65536);
      return text === undefined ? undefined : validate(JSON.parse(text));
    },
    save(connection: HubConnection): void { writePrivate(directory, 'hub-connection.json', JSON.stringify(validate(connection as any), null, 2) + '\n'); },
    reset(): void { if (existsSync(join(directory, 'hub-connection.json'))) unlinkSync(join(directory, 'hub-connection.json')); },
    /** Key files written by earlier builds; the hub holds the only copy the App needs. */
    removeLocalKeys(): string[] {
      const removed: string[] = [];
      for (const name of ['app-key.pem', 'trigger-key.pem']) if (existsSync(join(directory, name))) { unlinkSync(join(directory, name)); removed.push(name); }
      return removed;
    },
  };
}
export type HubRecords = ReturnType<typeof hubRecords>;
