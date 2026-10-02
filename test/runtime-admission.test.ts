import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveInvocationOrdered, type OrderedAdmissionStore, type Reservation } from '../src/runtime/admission.js';
import { digest } from '../src/runtime/configuration.js';
import { fixture } from './runtime-fixture.js';

/** An ordered ledger like the GitHub one: append first, decide against earlier records, record the outcome. */
function ledger() {
  const records: Array<{ position: number; reservation: Reservation; admitted?: boolean }> = [];
  let next = 1;
  let uncertain = false;
  const store: OrderedAdmissionStore = {
    append: async reservation => {
      const position = next++;
      records.push({ position, reservation: structuredClone(reservation) });
      if (uncertain) throw Error('Connection lost after durable append');
      return position;
    },
    read: async () => structuredClone(records),
    settle: async (position, admitted) => { records.find(entry => entry.position === position)!.admitted = admitted; },
  };
  return { store, records, admitted: () => records.filter(entry => entry.admitted).map(entry => entry.reservation), failAfterAppend() { uncertain = true; } };
}
const instant = { sleep: async () => {} };
const now = Date.UTC(2026, 8, 29);
const input = (index: number) => ({ resource: 'sample/repository', subjectId: String(index), runId: String(index),
  attempt: 1, inputDigest: digest(`task-${index}`), policyDigest: digest('policy') });
const limits = () => ({ ...fixture().limits, enabled: true, maxConcurrent: 10, maxRunsPerMonth: 100,
  maxRunsPerSubject: 2, timeoutMinutes: 1, maxModelCostMicrousdPerRun: 100, computeMicrousdPerMinute: 10, overheadMinutes: 5,
  maxCostMicrousdPerMonth: 480 });
const reserve = (state: ReturnType<typeof ledger>, budget: ReturnType<typeof limits>, value: ReturnType<typeof input>, at = now) =>
  reserveInvocationOrdered(state.store, budget, value, at, instant);

test('concurrent submissions cannot oversubscribe the budget and every reservation includes runner cost', async () => {
  const state = ledger();
  const outcomes = await Promise.all(Array.from({ length: 40 }, (_, index) => reserve(state, limits(), input(index))));
  assert.equal(outcomes.filter(result => result.allowed).length, 3);
  assert.equal(state.admitted().reduce((sum, record) => sum + record.reservedMicrousd, 0), 480);
  // Attempts still deciding count as admitted, so a refusal may name concurrency before cost; either way none overspends.
  assert.ok(outcomes.filter(result => !result.allowed).every(result => !result.allowed && ['monthly-cost-limit', 'concurrency-limit'].includes(result.reason)));
});

test('lost append acknowledgements, changed attempts and duplicated event delivery cannot launch again', async () => {
  const state = ledger();
  state.failAfterAppend();
  await assert.rejects(reserve(state, limits(), input(1)), /Connection lost/);
  const recovered = { ...state, store: { ...state.store, append: async (reservation: Reservation) => { state.records.push({ position: state.records.length + 1, reservation }); return state.records.length; } } };
  assert.deepEqual(await reserve(recovered, limits(), { ...input(1), attempt: 2 }), { allowed: false, reason: 'duplicate' });
  assert.deepEqual(await reserve(recovered, limits(), { ...input(1), runId: 'other' }), { allowed: false, reason: 'duplicate' });
  assert.equal(state.admitted().length, 0, 'an attempt whose append was uncertain never launches, and still blocks its replays');
});

test('expired reservations still consume monthly and per-subject quota; boundary-spanning execution consumes next month too', async () => {
  const state = ledger();
  const boundary = Date.UTC(2026, 9, 1);
  const budget = { ...limits(), maxCostMicrousdPerMonth: 160, maxRunsPerSubject: 1 };
  assert.equal((await reserve(state, budget, input(1), boundary - 30000)).allowed, true);
  assert.deepEqual(await reserve(state, budget, input(2), boundary + 60000), { allowed: false, reason: 'monthly-cost-limit' });
  assert.deepEqual(await reserve(state, budget, { ...input(1), runId: 'new', inputDigest: digest('changed') }, boundary + 60000), { allowed: false, reason: 'subject-limit' });
});

test('disabled launches perform no storage calls; incomplete or poisoned history never admits', async () => {
  const unavailable: OrderedAdmissionStore = { append: async () => { throw Error('Storage unavailable'); }, read: async () => { throw Error('Storage unavailable'); }, settle: async () => {} };
  assert.deepEqual(await reserveInvocationOrdered(unavailable, { ...limits(), enabled: false }, input(1), now, instant), { allowed: false, reason: 'disabled' });
  await assert.rejects(reserveInvocationOrdered(unavailable, limits(), input(1), now, instant), /unavailable/);
  const state = ledger();
  await reserve(state, limits(), input(1));
  state.records[0]!.reservation.reservedMicrousd = -1;
  await assert.rejects(reserve(state, limits(), input(2)));
});

test('a host without overhead reserves only the run itself; one with overhead reserves and holds it too', async () => {
  const { overheadMinutes: _overhead, ...none } = limits();
  const plain = await reserveInvocationOrdered(ledger().store, none, input(1), now, instant);
  assert.ok(plain.allowed);
  assert.deepEqual([plain.reservation.reservedMicrousd, plain.reservation.expiresAt - now], [100 + 1 * 10, 60000]);
  const held = await reserve(ledger(), limits(), input(1));
  assert.ok(held.allowed);
  assert.deepEqual([held.reservation.reservedMicrousd, held.reservation.expiresAt - now], [100 + 6 * 10, 360000]);
});
