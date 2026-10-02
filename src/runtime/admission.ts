import { canonicalJson, digest } from './configuration.js';

export interface AdmissionLimits {
  enabled: boolean;
  maxConcurrent: number;
  maxRunsPerSubject: number;
  maxRunsPerMonth: number;
  timeoutMinutes: number;
  /** Host minutes around each run (start-up, evidence upload, teardown), reserved with it. Defaults to 0. */
  overheadMinutes?: number;
  maxModelCostMicrousdPerRun: number;
  maxCostMicrousdPerMonth: number;
  computeMicrousdPerMinute: number;
}
export interface Reservation {
  schemaVersion: 1;
  resource: string;
  subjectId: string;
  runId: string;
  attempt: number;
  inputDigest: string;
  policyDigest: string;
  createdAt: number;
  expiresAt: number;
  reservedMicrousd: number;
}
export type AdmissionResult = { allowed: true; reservation: Reservation; reservationDigest: string } |
  { allowed: false; reason: 'disabled' | 'duplicate' | 'subject-limit' | 'monthly-run-limit' | 'concurrency-limit' | 'monthly-cost-limit' };

function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error('Invalid admission evidence');
}
function validReservation(record: Reservation): void {
  if (record.schemaVersion !== 1 || !record.resource || !record.subjectId || !record.runId ||
    !/^sha256:[a-f0-9]{64}$/.test(record.inputDigest) || !/^sha256:[a-f0-9]{64}$/.test(record.policyDigest)) throw Error('Invalid reservation');
  integer(record.attempt, 1); integer(record.createdAt, 0); integer(record.expiresAt, record.createdAt + 1);
  integer(record.reservedMicrousd, 1);
}

type Denial = Extract<AdmissionResult, { allowed: false }>['reason'];

function prepare(limits: AdmissionLimits, input: Omit<Reservation, 'schemaVersion' | 'createdAt' | 'expiresAt' | 'reservedMicrousd'>, now: number): Reservation {
  integer(now, 0, 8640000000000000 - 3600000);
  // Ceilings belong to the configuration schema; here every value only has to be a usable whole number.
  integer(limits.maxConcurrent, 1); integer(limits.maxRunsPerSubject, 1); integer(limits.maxRunsPerMonth, 1);
  integer(limits.timeoutMinutes, 1); integer(limits.maxModelCostMicrousdPerRun, 1);
  integer(limits.maxCostMicrousdPerMonth, 1); integer(limits.computeMicrousdPerMinute, 0); integer(limits.overheadMinutes ?? 0, 0);
  // The host is held, and paid for, for the run plus its own overhead.
  const jobMinutes = limits.timeoutMinutes + (limits.overheadMinutes ?? 0);
  const reservedMicrousd = limits.maxModelCostMicrousdPerRun + jobMinutes * limits.computeMicrousdPerMinute;
  integer(reservedMicrousd, 1);
  const reservation: Reservation = { ...input, schemaVersion: 1, createdAt: now, expiresAt: now + jobMinutes * 60000, reservedMicrousd };
  validReservation(reservation);
  return reservation;
}

/** Checks one reservation against the history admitted before it. */
function evaluate(history: Reservation[], reservation: Reservation, limits: AdmissionLimits, now: number): Denial | undefined {
  if (history.length > 100000) throw Error('Admission history requires archival verification');
  const identities = new Set<string>();
  for (const previous of history) {
    validReservation(previous);
    // Records come from different hosts whose clocks may differ, so an earlier record may carry a later time.
    if (previous.resource !== reservation.resource) throw Error('Mismatched admission history');
    const identity = `${previous.runId}:${previous.attempt}`;
    if (identities.has(identity)) throw Error('Duplicate reservation history');
    identities.add(identity);
  }
  // An identical task cannot be replayed, including a different attempt or a repeated event delivery.
  if (history.some(previous => previous.runId === reservation.runId ||
    (previous.subjectId === reservation.subjectId && previous.inputDigest === reservation.inputDigest))) return 'duplicate';
  if (history.filter(previous => previous.subjectId === reservation.subjectId).length >= limits.maxRunsPerSubject) return 'subject-limit';
  if (history.filter(previous => previous.expiresAt > now).length >= limits.maxConcurrent) return 'concurrency-limit';
  // Charge a reservation to both months if its possible execution crosses midnight on the first.
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const month = history.filter(previous => previous.expiresAt >= monthStart);
  if (month.length >= limits.maxRunsPerMonth) return 'monthly-run-limit';
  const total = month.reduce((sum, previous) => sum + BigInt(previous.reservedMicrousd), BigInt(reservation.reservedMicrousd));
  if (total > BigInt(limits.maxCostMicrousdPerMonth)) return 'monthly-cost-limit';
  return undefined;
}

/**
 * Admission without a lock: every attempt is appended first, then judged against the attempts that precede it in the
 * store's total order, and its outcome is recorded. Concurrent launchers therefore agree on who was admitted, and none
 * waits or is cancelled. Earlier attempts count by their recorded outcome; one without an outcome (still deciding, or
 * interrupted) counts as admitted, so uncertainty only ever refuses. Reservations are never refunded: crashes,
 * cancellations and lost usage reports still consume quota.
 */
export interface OrderedAdmissionStore {
  /** Durable before return; returns the record's position. Uncertain writes must throw and are never retried. */
  append(reservation: Reservation): Promise<number>;
  /** Complete history with positions and any recorded outcome; incomplete reads must throw. */
  read(): Promise<Array<{ position: number; reservation: Reservation; admitted?: boolean }>>;
  /** Records the outcome of this launcher's own attempt. */
  settle(position: number, admitted: boolean): Promise<void>;
}
export async function reserveInvocationOrdered(store: OrderedAdmissionStore, limits: AdmissionLimits,
  input: Omit<Reservation, 'schemaVersion' | 'createdAt' | 'expiresAt' | 'reservedMicrousd'>, now: number,
  options: { settleMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<AdmissionResult> {
  if (typeof limits.enabled !== 'boolean') throw Error('Invalid activation flag');
  if (!limits.enabled) return { allowed: false, reason: 'disabled' };
  const reservation = prepare(limits, input, now);
  const position = await store.append(reservation);
  const decide = async (): Promise<Denial | undefined> => {
    const history = await store.read();
    const own = history.filter(entry => entry.position === position);
    if (own.length !== 1 || canonicalJson(own[0]!.reservation) !== canonicalJson(reservation)) throw Error('Admission record not found after append');
    const earlier = history.filter(entry => entry.position < position && entry.admitted !== false).map(entry => entry.reservation);
    return evaluate(earlier, reservation, limits, now);
  };
  // A store may show a new record before an earlier one; deciding twice, a moment apart, refuses on either doubt.
  let reason = await decide();
  if (!reason) {
    await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(options.settleMs ?? 3000);
    reason = await decide();
  }
  // An unrecorded outcome counts as admitted for everyone else, which is the safe side.
  await store.settle(position, !reason).catch(() => undefined);
  if (reason) return { allowed: false, reason };
  return { allowed: true, reservation, reservationDigest: digest(canonicalJson(reservation)) };
}
