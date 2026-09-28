import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';
import type { UsageReport } from './usage-report.js';

/** Operator-owned, on-prem reporting destination. Never mount its directory in a guest. */
export function createUsageLedger(options: { directory: string; destinationId: string }) {
  const { destinationId } = options;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(destinationId)) throw Error('Invalid usage destination');
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || realpathSync(directory) !== directory || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw Error('Usage ledger requires an owned private directory without symlinks');
  const path = join(directory, 'usage.sqlite');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== stat.uid) throw Error('Unsafe usage ledger file');
  } finally { closeSync(fd); }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; BEGIN IMMEDIATE;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) throw Error('Unsupported usage ledger version');
    db.exec(`CREATE TABLE IF NOT EXISTS destination (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt_id TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT OR IGNORE INTO destination(id,name) VALUES(1,?)').run(destinationId);
    if (db.prepare('SELECT name FROM destination WHERE id=1').get()?.name !== destinationId) throw Error('Usage ledger destination changed');
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); throw error; }
  return {
    async deliver(report: UsageReport): Promise<{ eventId: string; receiptId: string }> {
      const payload = canonicalJson(report);
      if (report.schemaVersion !== 1 || report.destinationId !== destinationId || !/^[a-f0-9]{64}$/.test(report.eventId) || Buffer.byteLength(payload) > 16_384) throw Error('Invalid usage ledger report');
      const receiptId = createHash('sha256').update(payload).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT payload FROM reports WHERE event_id=?').get(report.eventId);
        if (previous && previous.payload !== payload) throw Error('Usage event identity already has different content');
        db.prepare('INSERT OR IGNORE INTO reports(event_id,payload,receipt_id) VALUES(?,?,?)').run(report.eventId, payload, receiptId);
        db.exec('COMMIT');
        // The synchronous commit precedes acknowledgement, including replay.
        return { eventId: report.eventId, receiptId };
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    get(eventId: string): UsageReport | null {
      const row = db.prepare('SELECT payload FROM reports WHERE event_id=?').get(eventId);
      return row ? JSON.parse(String(row.payload)) : null;
    },
    list(limit = 100): UsageReport[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid usage report limit');
      return db.prepare('SELECT payload FROM reports ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(String(row.payload)));
    },
    close() { db.close(); },
  };
}
