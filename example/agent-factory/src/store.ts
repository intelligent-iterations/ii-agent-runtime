import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface TaskRecord {
  id: string; project: string; name: string; input: string; digest: string;
  state: TaskState; cancelRequested: boolean; result: unknown;
}
export class WorkStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported work-store version'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, input TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
      cancel_requested INTEGER NOT NULL DEFAULT 0, result TEXT, UNIQUE(project,name)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','finished')), outcome TEXT, result TEXT, UNIQUE(task_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS attempt_records (
      attempt_id TEXT NOT NULL REFERENCES attempts(id), key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(attempt_id,key)
    );
    CREATE TABLE IF NOT EXISTS controllers (
      project TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL
    ); PRAGMA user_version=1;`);
  }
  close(): void { this.db.close(); }
  /** Only a confirmed dead local process can surrender controller ownership after a crash. */
  acquireController(project: string): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM controllers WHERE project=?').get(project);
      if (row) {
        if (row.host !== hostname()) throw Error('Controller belongs to another host');
        let dead = false;
        try { process.kill(Number(row.pid), 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw Error('A controller may still be alive');
      }
      const owner = randomUUID();
      this.db.prepare('INSERT INTO controllers(project,owner,pid,host) VALUES(?,?,?,?) ON CONFLICT(project) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,host=excluded.host').run(project,owner,process.pid,hostname());
      this.db.exec('COMMIT'); return owner;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  releaseController(project: string, owner: string): void {
    const result = this.db.prepare('DELETE FROM controllers WHERE project=? AND owner=?').run(project,owner);
    if (result.changes !== 1) throw Error('Controller ownership changed');
  }
  submit(project: string, name: string, value: unknown): TaskRecord {
    const input = canonicalJson(value);
    const digest = createHash('sha256').update(input).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id,digest FROM tasks WHERE project=? AND name=?').get(project,name);
      if (existing) {
        if (existing.digest !== digest) throw new Error('Agent name already has different inputs');
        this.db.exec('COMMIT'); return this.get(String(existing.id));
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO tasks(id,project,name,input,digest,state) VALUES(?,?,?,?,?,'queued')").run(id,project,name,input,digest);
      this.db.exec('COMMIT'); return this.get(id);
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('Unknown agent');
    return { id: String(row.id), project: String(row.project), name: String(row.name), input: String(row.input), digest: String(row.digest),
      state: row.state as TaskState, cancelRequested: row.cancel_requested === 1, result: row.result === null ? null : JSON.parse(String(row.result)) };
  }
  candidates(project: string, limit = Number.MAX_SAFE_INTEGER): TaskRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw Error('Invalid candidate limit');
    return this.db.prepare("SELECT id FROM tasks WHERE project=? AND state='queued' AND cancel_requested=0 ORDER BY rowid LIMIT ?").all(project, limit).map(row => this.get(String(row.id)));
  }
  list(project: string): TaskRecord[] {
    return this.db.prepare('SELECT id FROM tasks WHERE project=? ORDER BY rowid').all(project).map(row => this.get(String(row.id)));
  }
  snapshot(id: string) {
    this.db.exec('BEGIN');
    try {
      const task = this.get(id); const attempts = this.attempts(id);
      this.db.exec('COMMIT'); return { task, attempts };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  attempts(taskId: string): Array<{ id: string; ordinal: number; state: 'running' | 'finished'; outcome: string | null; result: unknown; recoveryRequired: boolean; lastActivityAt: string | null }> {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY ordinal').all(taskId).map(row => {
      const activity = this.record(String(row.id), 'activity_at');
      return {
        id: String(row.id), ordinal: Number(row.ordinal), state: row.state as 'running' | 'finished',
        outcome: row.outcome === null ? null : String(row.outcome), result: row.result === null ? null : JSON.parse(String(row.result)),
        recoveryRequired: row.state === 'running' && this.record(String(row.id), 'execution_error') !== null,
        lastActivityAt: typeof activity === 'string' && Number.isFinite(Date.parse(activity)) ? new Date(activity).toISOString() : null,
      };
    });
  }
  activeAttempt(taskId: string): string | null {
    const row = this.db.prepare("SELECT id FROM attempts WHERE task_id=? AND state='running'").get(taskId);
    return row ? String(row.id) : null;
  }
  attempt(id: string): { taskId: string; state: 'running' | 'finished'; outcome: string | null; result: unknown } {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
    if (!row) throw new Error('Unknown attempt');
    return { taskId: String(row.task_id), state: row.state as 'running' | 'finished', outcome: row.outcome === null ? null : String(row.outcome), result: row.result === null ? null : JSON.parse(String(row.result)) };
  }
  checkpoint(attemptId: string, key: string, value: unknown): void {
    this.db.prepare('INSERT INTO attempt_records(attempt_id,key,value) VALUES(?,?,?) ON CONFLICT(attempt_id,key) DO UPDATE SET value=excluded.value').run(attemptId,key,canonicalJson(value));
  }
  record(attemptId: string, key: string): unknown {
    const row=this.db.prepare('SELECT value FROM attempt_records WHERE attempt_id=? AND key=?').get(attemptId,key);
    return row ? JSON.parse(String(row.value)) : null;
  }
  requestCancel(id: string): void {
    this.get(id);
    this.db.prepare("UPDATE tasks SET cancel_requested=1, state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE id=? AND state IN ('queued','running')").run(id);
  }
  claim(id: string): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE tasks SET state='running' WHERE id=? AND state='queued' AND cancel_requested=0").run(id);
      if (!changed.changes) { this.db.exec('COMMIT'); return null; }
      const ordinal = Number(this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(id)?.n) + 1;
      const attempt = randomUUID();
      this.db.prepare("INSERT INTO attempts(id,task_id,ordinal,state) VALUES(?,?,?,'running')").run(attempt,id,ordinal);
      this.db.exec('COMMIT'); return attempt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(attempt: string, outcome: 'succeeded' | 'failed' | 'cancelled' | 'retry', result: unknown): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT task_id FROM attempts WHERE id=? AND state='running'").get(attempt);
      if (!row) throw new Error('Attempt is not active');
      const task = this.get(String(row.task_id));
      // Cancellation wins over a late completion; controller must finish resource cleanup before calling this.
      const state = task.cancelRequested ? 'cancelled' : outcome === 'retry' ? 'queued' : outcome;
      this.db.prepare("UPDATE attempts SET state='finished',outcome=?,result=? WHERE id=?").run(task.cancelRequested ? 'cancelled' : outcome,canonicalJson(result),attempt);
      this.db.prepare('UPDATE tasks SET state=?,result=? WHERE id=?').run(state,canonicalJson(result),task.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
