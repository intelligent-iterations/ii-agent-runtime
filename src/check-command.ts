import { isAbsolute } from 'node:path';
import { commands } from './deployment/commands.js';
import { type CheckContext, type Observation } from './checks.js';
import { canonicalJson } from './setup.js';

/** Explicitly selected, trusted executable. It is an integration, never setup data. */
export async function commandCheckContext(
  binary?: string,
  timeoutMs = 10_000,
): Promise<CheckContext> {
  const unknown = (): Observation => ({
    status: 'unknown',
    evidenceId: 'unavailable',
  });
  if (binary !== undefined && !isAbsolute(binary))
    throw Error('Checker executable path must be absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw Error('Invalid checker timeout');
  const invoke = async (
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    if (!binary) return null;
    try {
      const response = JSON.parse(
        await commands.run(binary, [], {
          cwd: process.cwd(),
          env: { ...process.env, NODE_OPTIONS: '' },
          timeoutMs,
          input: canonicalJson({ schemaVersion: 1, ...request }) + '\n',
        }),
      );
      return response &&
        typeof response === 'object' &&
        !Array.isArray(response)
        ? response
        : null;
    } catch {
      return null;
    }
  };
  const identity = await invoke({ operation: 'identify' });
  const subject =
    identity &&
    Object.keys(identity).length === 1 &&
    typeof identity.subject === 'string' &&
    /^[A-Za-z0-9_.:@/-]{1,160}$/.test(identity.subject)
      ? identity.subject
      : '';
  const observation = async (
    request: Record<string, unknown>,
  ): Promise<Observation> => {
    const result = await invoke(request);
    if (
      !result ||
      Object.keys(result).sort().join(',') !== 'evidenceId,status' ||
      !['verified', 'denied', 'unknown'].includes(String(result.status)) ||
      typeof result.evidenceId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,160}$/.test(result.evidenceId)
    )
      return unknown();
    return {
      status: result.status as Observation['status'],
      evidenceId: result.evidenceId,
    };
  };
  return {
    subject,
    authorize: (caller, setup) =>
      observation({ operation: 'authorize', subject: caller, setup }),
    inspectSecret: (reference) =>
      observation({ operation: 'inspect-secret', subject, reference }),
  };
}
