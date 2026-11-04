import { createToolSession } from '../../runtime/tools.js';
import { admitToolSession, preflightTools } from '../../runtime/preflight.js';
import { githubPermissionPreflight, type GitHubEvidenceCollector, type WorkflowIdentityAssessors } from './github-preflight.js';
import { awsPermissionPreflight, azurePermissionPreflight, gcpPermissionPreflight, type AuthorityInventory } from './preflight.js';
import type { PreflightInput } from '../../runtime/preflight.js';

/** The shipped provider rules are selected automatically; developers do not author security checklists. */
export async function prepareTools(
  options: Parameters<typeof createToolSession>[0],
  preflight: {
    github?: GitHubEvidenceCollector;
    /** Cloud adapters for identities that workflow jobs request, such as `{ aws: awsWorkflowRoleAssessor(...), gcp: gcpWorkflowServiceAccountAssessor(...) }`. */
    workflowIdentity?: WorkflowIdentityAssessors;
    aws?: (input: PreflightInput) => Promise<AuthorityInventory>;
    gcp?: (input: PreflightInput) => Promise<AuthorityInventory>;
    azure?: (input: PreflightInput) => Promise<AuthorityInventory>;
    /** Defaults to every shipped check. Any omitted checks remain advisory and visible. */
    requiredChecks?: readonly string[];
    maxAgeMs?: number;
  } = {},
) {
  const session = createToolSession(options);
  const report = await preflightTools(session, {
    inspectors: [githubPermissionPreflight(preflight.github, preflight.workflowIdentity ? { workflowIdentity: preflight.workflowIdentity } : {}), awsPermissionPreflight(preflight.aws),
      gcpPermissionPreflight(preflight.gcp), azurePermissionPreflight(preflight.azure)],
    signal: options.context.signal,
    ...(preflight.maxAgeMs === undefined ? {} : { maxAgeMs: preflight.maxAgeMs }),
  });
  admitToolSession(session, report, preflight.requiredChecks);
  return { session, report };
}
