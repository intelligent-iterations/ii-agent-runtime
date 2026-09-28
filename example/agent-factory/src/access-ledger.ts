import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CapabilityGrant } from '@intelligent-iterations/ii-agent-runtime';

export interface GrantIntent {
  provider: string;
  recipient: string;
  resource: string;
  capabilities: string[];
  authorizedBy: string | null;
  issuedBy: string;
  policyRevision: string;
  attemptId: string | null;
  credentialReference: string;
}
export interface GrantEvent {
  eventId: string;
  grantId: string;
  kind: 'requested' | 'issued' | 'delivered' | 'observed' | 'ended';
  at: string;
  intent?: GrantIntent;
  capabilities?: string[];
  expiresAt?: string | null;
  observation?: 'verified' | 'denied' | 'unknown';
  evidenceId?: string;
  reason?: 'expired' | 'revoked' | 'attempt_finished' | 'provider_removed';
}
export interface InstallationEvent {
  eventId: string;
  repository: string;
  installationId: number;
  action: 'granted' | 'removed';
  actor: string;
  at: string;
  observedAt: string;
  source: 'signed_webhook' | 'app_delivery' | 'human_review';
  evidenceId: string;
}
const label = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_.:/@-]{1,240}$/.test(value);
const iso = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const capabilities = (value: unknown) => Array.isArray(value) && value.every(label) && new Set(value).size === value.length;

/** Private local audit history. Only fixed metadata fields can cross this boundary. */
export function createAccessLedger(directory: string) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || realpathSync(root) !== root || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error('Unsafe access ledger directory');
  const path = join(root, 'access.sqlite');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== stat.uid || (file.mode & 0o077)) throw Error('Unsafe access ledger file');
  } finally { closeSync(fd); }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
      kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_grant ON events(grant_id, seq);
    CREATE TABLE IF NOT EXISTS installation_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
      repository TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS installation_repository ON installation_events(repository, seq);`);
  function append(event: GrantEvent): GrantEvent {
    if (!label(event.eventId) || !label(event.grantId) || !iso(event.at) ||
        !['requested', 'issued', 'delivered', 'observed', 'ended'].includes(event.kind)) throw Error('Invalid access event');
    if (event.kind === 'requested') {
      const intent = event.intent;
      if (!intent || ![intent.provider, intent.recipient, intent.resource, intent.issuedBy, intent.policyRevision, intent.credentialReference].every(label) ||
          (intent.authorizedBy !== null && !label(intent.authorizedBy)) || (intent.attemptId !== null && !label(intent.attemptId)) ||
          !capabilities(intent.capabilities) || !intent.capabilities.length) throw Error('Invalid grant intent');
    } else if (event.intent !== undefined) throw Error('Unexpected grant intent');
    if (event.capabilities !== undefined && !capabilities(event.capabilities)) throw Error('Invalid observed capabilities');
    if (event.expiresAt !== undefined && event.expiresAt !== null && !iso(event.expiresAt)) throw Error('Invalid expiry');
    if (event.evidenceId !== undefined && !label(event.evidenceId)) throw Error('Invalid evidence');
    if (event.kind === 'observed' && (!['verified', 'denied', 'unknown'].includes(event.observation ?? '') || !event.evidenceId)) throw Error('Invalid observation');
    if (event.kind === 'ended' && !['expired', 'revoked', 'attempt_finished', 'provider_removed'].includes(event.reason ?? '')) throw Error('Invalid end reason');
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > 8192) throw Error('Access event too large');
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT payload FROM events WHERE event_id=?').get(event.eventId);
      if (prior && prior.payload !== payload) throw Error('Access event ID already used');
      const first = db.prepare('SELECT kind FROM events WHERE grant_id=? ORDER BY seq LIMIT 1').get(event.grantId);
      if (!first && event.kind !== 'requested') throw Error('Grant must begin with an intent');
      if (first && event.kind === 'requested' && !prior) throw Error('Grant already exists');
      if (!prior) db.prepare('INSERT INTO events(event_id,grant_id,kind,at,payload) VALUES(?,?,?,?,?)').run(event.eventId, event.grantId, event.kind, event.at, payload);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    return event;
  }
  function events(grantId?: string): GrantEvent[] {
    const rows = grantId ? db.prepare('SELECT payload FROM events WHERE grant_id=? ORDER BY seq').all(grantId) : db.prepare('SELECT payload FROM events ORDER BY seq').all();
    return rows.map(row => JSON.parse(String(row.payload)) as GrantEvent);
  }
  function current(): CapabilityGrant[] {
    const groups = new Map<string, GrantEvent[]>();
    for (const event of events()) groups.set(event.grantId, [...(groups.get(event.grantId) ?? []), event]);
    return [...groups.entries()].map(([id, history]) => {
      const first = history[0]!; const intent = first.intent!;
      const issued = history.find(event => event.kind === 'issued');
      const lastObservation = history.filter(event => event.kind === 'observed').at(-1);
      const ended = history.find(event => event.kind === 'ended');
      return { id, provider: intent.provider, recipient: intent.recipient, resource: intent.resource,
        capabilities: issued?.capabilities ?? intent.capabilities, authorizedBy: intent.authorizedBy, issuedBy: intent.issuedBy,
        policyRevision: intent.policyRevision, attemptId: intent.attemptId, requestedAt: first.at,
        grantedAt: issued?.at ?? null, expiresAt: issued?.expiresAt ?? null, endedAt: ended?.at ?? null,
        observedAt: lastObservation?.at ?? null, observation: lastObservation?.observation ?? 'unknown' };
    });
  }
  function recordInstallation(event: InstallationEvent): void {
    if (!label(event.eventId) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(event.repository) ||
        !Number.isSafeInteger(event.installationId) || event.installationId < 1 ||
        !['granted', 'removed'].includes(event.action) || !label(event.actor) || !iso(event.at) || !iso(event.observedAt) ||
        !['signed_webhook', 'app_delivery', 'human_review'].includes(event.source) || !label(event.evidenceId)) throw Error('Invalid installation evidence');
    const normalized = { ...event, repository: event.repository.toLowerCase() };
    const payload = JSON.stringify(normalized);
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT payload FROM installation_events WHERE event_id=?').get(event.eventId);
      if (prior && prior.payload !== payload) throw Error('Installation evidence ID already used');
      if (!prior) db.prepare('INSERT INTO installation_events(event_id,repository,payload) VALUES(?,?,?)')
        .run(event.eventId, normalized.repository, payload);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function installationEvents(repository?: string): InstallationEvent[] {
    const rows = repository ? db.prepare('SELECT payload FROM installation_events WHERE repository=? ORDER BY seq').all(repository.toLowerCase()) :
      db.prepare('SELECT payload FROM installation_events ORDER BY seq').all();
    return rows.map(row => JSON.parse(String(row.payload)) as InstallationEvent);
  }
  function latestInstallation(repository: string): InstallationEvent | null {
    return installationEvents(repository).sort((left, right) => left.at.localeCompare(right.at)).at(-1) ?? null;
  }
  return {
    request(intent: GrantIntent, id = randomUUID()): string { append({ eventId: `${id}:request`, grantId: id, kind: 'requested', at: new Date().toISOString(), intent }); return id; },
    append, events, current, recordInstallation, installationEvents, latestInstallation, close() { db.close(); },
  };
}
