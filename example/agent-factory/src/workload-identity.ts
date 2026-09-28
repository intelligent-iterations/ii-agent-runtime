import { createHash } from 'node:crypto';
import { canonicalJson } from '@intelligent-iterations/ii-agent-runtime';

/** Identity of the staged workload, excluding generated execution/attempt IDs. */
export function workloadDigest(input: Record<string, unknown>, bundleDigest: string, workflowCommit: string): string {
  if (!/^[a-f0-9]{64}$/.test(bundleDigest) || !/^[a-f0-9]{40}$/.test(workflowCommit)) throw Error('Invalid workload revisions');
  const { executionId: _executionId, attemptId: _attemptId, ...task } = input;
  return 'sha256:' + createHash('sha256').update(canonicalJson({ task, bundleDigest, workflowCommit })).digest('hex');
}
