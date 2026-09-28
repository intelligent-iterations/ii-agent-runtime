import { WorkStore, type TaskRecord } from './store.js';

export interface ExecutionContext {
  attemptId: string;
  task: TaskRecord;
  cancelled(): boolean;
  checkpoint(key: string, value: unknown): void;
  record(key: string): unknown;
}

/** Resolve only after retention and cleanup. Ambiguous failures remain recoverable. */
export type AttemptExecutor = (context: ExecutionContext) => Promise<{ outcome: 'succeeded' | 'failed' | 'cancelled' | 'retry'; result: unknown }>;

/** The factory's local scheduler; the caller owns the database and worker infrastructure. */
export async function startLocalCoordinator(options: {
  database: string; project: string; execute: AttemptExecutor; recover?: AttemptExecutor;
  maxConcurrentAgents?: number; pollMs?: number;
}) {
  const maximum = options.maxConcurrentAgents ?? 2;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(maximum) || maximum < 1 ||
      !Number.isSafeInteger(pollMs) || pollMs < 10) throw Error('Invalid coordinator limits');
  const store = new WorkStore(options.database);
  let owner: string;
  try { owner = store.acquireController(options.project); }
  catch (error) { store.close(); throw error; }
  const running = new Set<string>();
  const executions = new Set<Promise<void>>();
  let closing = false;
  let wake: (() => void) | undefined;
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  function begin(attemptId: string, task: TaskRecord, recovery = false) {
    if (running.has(attemptId)) return;
    const action = recovery ? options.recover : options.execute;
    if (!action) { store.checkpoint(attemptId, 'execution_error', { state: 'recovery_required' }); return; }
    store.checkpoint(attemptId, 'execution_error', null);
    running.add(attemptId);
    const context: ExecutionContext = {
      attemptId, task, cancelled: () => store.get(task.id).cancelRequested,
      checkpoint(key, value) { store.checkpoint(attemptId, key, value); store.checkpoint(attemptId, 'activity_at', new Date().toISOString()); },
      record: key => store.record(attemptId, key),
    };
    const execution = Promise.resolve().then(() => action(context)).then(result => {
      store.finish(attemptId, result.outcome, result.result);
    }).catch(() => {
      // A lost provider response may leave a VM or Actions job alive.
      store.checkpoint(attemptId, 'execution_error', { state: 'recovery_required' });
    }).finally(() => { running.delete(attemptId); executions.delete(execution); wake?.(); });
    executions.add(execution);
  }
  for (const task of store.list(options.project)) {
    const active = store.activeAttempt(task.id);
    if (active) begin(active, task, true);
  }
  const loop = (async () => {
    try {
      while (!closing) {
        for (const task of store.candidates(options.project, maximum - running.size)) {
          if (closing || running.size >= maximum) break;
          const attempt = store.claim(task.id);
          if (attempt) begin(attempt, task);
        }
        if (closing) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, pollMs);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
    } catch (error) { fail(error instanceof Error ? error : Error('Local coordinator failed')); }
  })();
  let shutdown: Promise<void> | undefined;
  return {
    failure,
    close(): Promise<void> {
      shutdown ??= (async () => {
        closing = true; wake?.(); await loop;
        await Promise.allSettled(executions);
        store.releaseController(options.project, owner); store.close();
      })();
      return shutdown;
    },
  };
}
