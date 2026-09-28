import { randomUUID } from 'node:crypto';
import { object, repositoryPath, type GitHubTransport, type GitHubResponse } from './github.js';

export interface RunnerIntent {
  schemaVersion: 1;
  operationId: string;
  repository: string;
  name: string;
  ownershipLabel: string;
  groupId: number;
  workFolder: string;
}
export interface RunnerReceipt { intent: RunnerIntent; runnerId: number }
export interface RunnerState { receipt: RunnerReceipt; status: 'online' | 'offline'; busy: boolean }
export class RunnerOperationUncertain extends Error {
  constructor(readonly intent: RunnerIntent) { super('Runner operation outcome unknown; reconcile before retrying'); }
}
async function request(transport: GitHubTransport, intent: RunnerIntent, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<GitHubResponse> {
  try { return await transport.request(method, path, body); }
  catch { throw new RunnerOperationUncertain(intent); }
}
export function runnerIntent(repository: string, options: { groupId: number; workFolder: string }): RunnerIntent {
  const { groupId, workFolder } = options;
  repositoryPath(repository);
  if (!Number.isSafeInteger(groupId) || groupId < 1) throw new Error('Invalid runner group');
  if (!/^[A-Za-z0-9_-]+$/.test(workFolder)) throw new Error('Invalid runner work folder');
  const operationId = randomUUID();
  return { schemaVersion: 1, operationId, repository, groupId, workFolder, name: `runtime-${operationId}`, ownershipLabel: `runtime-${operationId}` };
}
function validateIntent(input: RunnerIntent): RunnerIntent {
  repositoryPath(input.repository);
  if (input.schemaVersion !== 1 || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.operationId) ||
      input.name !== `runtime-${input.operationId}` || input.ownershipLabel !== input.name ||
      !Number.isSafeInteger(input.groupId) || input.groupId < 1 || typeof input.workFolder !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.workFolder)) throw new Error('Invalid runner intent');
  return { schemaVersion: 1, operationId: input.operationId, repository: input.repository,
    groupId: input.groupId, workFolder: input.workFolder, name: input.name, ownershipLabel: input.ownershipLabel };
}
function runner(body: unknown, intent: RunnerIntent): RunnerState {
  const value = object(body);
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1 || value.name !== intent.name ||
      !Array.isArray(value.labels) || !value.labels.some(label => object(label).name === intent.ownershipLabel) ||
      !['online', 'offline'].includes(value.status as string) || typeof value.busy !== 'boolean') throw new Error('Runner identity mismatch');
  return { receipt: { intent, runnerId: value.id as number }, status: value.status as 'online' | 'offline', busy: value.busy };
}

/** Bounded inventory; failure or truncated pagination never becomes evidence of absence. */
export async function findGitHubRunner(transport: GitHubTransport, input: RunnerIntent): Promise<RunnerState | null> {
  const intent = validateIntent(input);
  const found: RunnerState[] = [];
  const seen = new Set<number>();
  let expected: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const response = await request(transport, intent, 'GET', `${repositoryPath(intent.repository)}/actions/runners?per_page=100&page=${page}`);
    if (response.status !== 200) throw new RunnerOperationUncertain(intent);
    const body = object(response.body);
    if (!Number.isSafeInteger(body.total_count) || (body.total_count as number) < 0 || !Array.isArray(body.runners)) throw new RunnerOperationUncertain(intent);
    if (expected !== undefined && expected !== body.total_count) throw new RunnerOperationUncertain(intent);
    expected = body.total_count as number;
    for (const value of body.runners) {
      const item = object(value);
      if (!Number.isSafeInteger(item.id) || seen.has(item.id as number)) throw new RunnerOperationUncertain(intent);
      seen.add(item.id as number);
      if (item.name === intent.name) found.push(runner(item, intent));
    }
    if (body.runners.length < 100) {
      if (seen.size !== expected || found.length > 1) throw new RunnerOperationUncertain(intent);
      return found[0] ?? null;
    }
  }
  throw new RunnerOperationUncertain(intent);
}

/** One POST only. Persist intent before this call; persist receipt before delivering credentials. */
export async function registerGitHubRunner(
  transport: GitHubTransport, input: RunnerIntent,
  checkpoints: { intent(value: RunnerIntent): Promise<void>; receipt(value: RunnerReceipt): Promise<void> },
  deliver: (encodedConfiguration: string) => Promise<void>,
): Promise<RunnerReceipt> {
  const intent = validateIntent(input);
  await checkpoints.intent({ ...intent });
  if (await findGitHubRunner(transport, intent)) throw new Error('Runner already exists; reconcile retained receipt');
  try {
    const response = await request(transport, intent, 'POST', `${repositoryPath(intent.repository)}/actions/runners/generate-jitconfig`, {
      name: intent.name, runner_group_id: intent.groupId, labels: ['self-hosted', intent.ownershipLabel], work_folder: intent.workFolder,
    });
    if (response.status !== 201) throw new RunnerOperationUncertain(intent);
    const body = object(response.body);
    const receipt = runner(body.runner, intent).receipt;
    if (typeof body.encoded_jit_config !== 'string' || !body.encoded_jit_config) throw new RunnerOperationUncertain(intent);
    await checkpoints.receipt({ ...receipt, intent: { ...intent } });
    // Sensitive material exists only for the consumer's handoff; it is never a return value or record.
    await deliver(body.encoded_jit_config);
    return receipt;
  } catch { throw new RunnerOperationUncertain(intent); }
}

/** Removal verifies both numeric identity and ownership before issuing DELETE. It does not destroy a VM. */
export async function removeGitHubRunner(transport: GitHubTransport, receipt: RunnerReceipt): Promise<'removed' | 'absent'> {
  const intent = validateIntent(receipt.intent);
  if (!Number.isSafeInteger(receipt.runnerId) || receipt.runnerId < 1) throw new Error('Invalid runner identity');
  const runnerId = receipt.runnerId;
  const path = `${repositoryPath(intent.repository)}/actions/runners/${runnerId}`;
  const response = await request(transport, intent, 'GET', path);
  if (response.status === 404) {
    if (await findGitHubRunner(transport, intent)) throw new RunnerOperationUncertain(intent);
    return 'absent';
  }
  if (response.status !== 200) throw new RunnerOperationUncertain(intent);
  const current = runner(response.body, intent);
  if (current.receipt.runnerId !== runnerId) throw new Error('Runner identity mismatch');
  const removed = await request(transport, intent, 'DELETE', path);
  if (removed.status !== 204) throw new RunnerOperationUncertain(intent);
  if (await findGitHubRunner(transport, intent)) throw new RunnerOperationUncertain(intent);
  return 'removed';
}
