import { lstatSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { EvalDatabase } from './imported/storage/evalDb.js';
import type { TelemetryStore } from './store.js';
/** Optional adapter. No database is opened unless the consumer explicitly calls this function. */
export function createSqliteTelemetryStore(database: string): TelemetryStore {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  if (existsSync(database)) {
    const stat = lstatSync(database);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Error('Telemetry database must be a private regular file');
  } else closeSync(openSync(database, 'wx', 0o600));
  const db = new EvalDatabase(database);
  try { db.init(); return db; } catch (error) { db.close(); throw error; }
}
/** Read this adapter's retained database without creating or modifying it. */
export function readSqliteTelemetryEvents(database: string, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw Error('Invalid telemetry read limit');
  const db = new EvalDatabase(database, { readOnly: true });
  try { db.init(); return db.listEvents(limit); } finally { db.close(); }
}
