import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccessLedger } from './github-app.js';

const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);

function recordPayload(ledger: AccessLedger, payload: Record<string, unknown>, event: string,
  deliveryId: string, observedAt: string, source: 'signed_webhook' | 'app_delivery'): number {
  const installation = payload.installation as { id?: unknown } | undefined;
  const sender = payload.sender as { login?: unknown } | undefined;
  if (!installation || !Number.isSafeInteger(installation.id) || !identity(sender?.login)) throw Error('Installation event lacks actor or installation');
  const action = payload.action;
  const changes: Array<{ repository: string; action: 'granted' | 'removed' }> = [];
  const append = (entries: unknown, change: 'granted' | 'removed') => {
    if (!Array.isArray(entries)) throw Error('Installation event repository list missing');
    for (const entry of entries) {
      const repository = (entry as { full_name?: unknown })?.full_name;
      if (!name(repository)) throw Error('Invalid installation event repository');
      changes.push({ repository, action: change });
    }
  };
  if (event === 'installation') {
    if (action === 'created' || action === 'unsuspend' || action === 'new_permissions_accepted') append(payload.repositories, 'granted');
    else if (action === 'deleted' || action === 'suspend') append(payload.repositories, 'removed');
    else return 0;
  } else if (event === 'installation_repositories') {
    if (action !== 'added' && action !== 'removed') throw Error('Unsupported installation repository event');
    append(payload.repositories_added ?? [], 'granted');
    append(payload.repositories_removed ?? [], 'removed');
  } else throw Error('Unsupported installation event');
  const providerTime = action === 'created' ? (installation as { created_at?: unknown }).created_at :
    (installation as { updated_at?: unknown }).updated_at;
  const occurred = Number.isFinite(Date.parse(String(providerTime))) ? new Date(String(providerTime)).toISOString() : observedAt;
  if (Date.parse(occurred) > Date.parse(observedAt) + 60_000) throw Error('Installation event time is in the future');
  changes.forEach(({ repository, action: change }, index) => ledger.recordInstallation({
    eventId: `${deliveryId}:${index}`, repository, installationId: installation.id as number,
    action: change, actor: sender.login as string, at: occurred, observedAt, source, evidenceId: `github-delivery:${deliveryId}`,
  }));
  return changes.length;
}

/** Ingest the exact signed GitHub delivery bytes. A caller must retain the delivery ID and headers. */
export function ingestInstallationWebhook(ledger: AccessLedger, input: {
  body: Buffer; signature: string; secret: string; event: string; deliveryId: string; receivedAt?: Date;
}): number {
  if (!input.secret || !/^sha256=[a-f0-9]{64}$/.test(input.signature) || !identity(input.deliveryId) ||
      !['installation', 'installation_repositories'].includes(input.event) || input.body.length > 1024 * 1024) throw Error('Invalid installation webhook envelope');
  const supplied = Buffer.from(input.signature.slice(7), 'hex');
  const expected = createHmac('sha256', input.secret).update(input.body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw Error('Invalid installation webhook signature');
  const payload = JSON.parse(input.body.toString('utf8')) as Record<string, unknown>;
  const count = recordPayload(ledger, payload, input.event, input.deliveryId, (input.receivedAt ?? new Date()).toISOString(), 'signed_webhook');
  if (!count) throw Error('Installation webhook has no repository changes');
  return count;
}

/** GitHub's App JWT endpoint provides authenticated delivery payloads without organization audit access. */
export function ingestAppDelivery(ledger: AccessLedger, delivery: unknown): number {
  const item = delivery as { id?: unknown; event?: unknown; delivered_at?: unknown;
    request?: { payload?: unknown; headers?: Record<string, unknown> } } | null;
  if (!item || !Number.isSafeInteger(item.id) || !['installation', 'installation_repositories'].includes(String(item.event)) ||
      !item.request?.payload || typeof item.request.payload !== 'object' || Array.isArray(item.request.payload) ||
      !Number.isFinite(Date.parse(String(item.delivered_at)))) throw Error('Invalid App delivery');
  const header = item.request.headers?.['X-GitHub-Delivery'] ?? item.request.headers?.['x-github-delivery'];
  if (header !== undefined && !identity(header)) throw Error('Invalid App delivery header');
  return recordPayload(ledger, item.request.payload as Record<string, unknown>, String(item.event),
    `app-delivery:${item.id}`, new Date(String(item.delivered_at)).toISOString(), 'app_delivery');
}

/** Use only after an administrator reviews a missed GitHub audit entry. */
export function recordInstallationReview(ledger: AccessLedger, input: {
  repository: string; installationId: number; action: 'granted' | 'removed'; actor: string; occurredAt: string; auditEventId: string;
}): void {
  if (!identity(input.auditEventId)) throw Error('GitHub audit event ID is required');
  ledger.recordInstallation({ eventId: `audit:${input.auditEventId}`, repository: input.repository,
    installationId: input.installationId, action: input.action, actor: input.actor,
    at: input.occurredAt, observedAt: new Date().toISOString(), source: 'human_review', evidenceId: `github-audit:${input.auditEventId}` });
}
