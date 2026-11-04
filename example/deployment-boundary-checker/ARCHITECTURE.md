# Architecture

```
grants file (TypeScript)       workflow files                 GCP (reader access token)
  defineTool / createGrant      local dir or GitHub API        account + project IAM policies,
          │                           │                        Policy Troubleshooter
          ▼                           ▼                                 │
  createToolSession ──▶ preflightTools ── githubPermissionPreflight ── { gcp: gcpWorkflowServiceAccountAssessor }
                              │              (workflowIdentity adapter)
                              ▼
                    report: github.workflow-execution
                    finding | clear | unknown, path, evidence, limits
                              │
                    admitToolSession ──▶ admitted | blocked
                              │
                         CLI answer + comparison
```

The example is a consumer of three runtime entry points: `/runtime` (grants,
session, preflight, admission), `/tools` (GitHub contents tool, GitHub and GCP
preflight adapters) and `/cli` (report formatting and terminal escaping). It never
imports runtime source.

The example adds only presentation and setup checks around them: plain messages
for grants-file and setup mistakes, the workflow files actually inspected, and
notes for failed reads. It wraps the GitHub and GCP adapters' fetch to note which
reads failed and their HTTP status. The notes use fixed wording only: they never
include response bodies or the reader token. The runtime's decisions are
unchanged.

The checker creates a tool session only to run preflight. Its credential
resolver always throws, so the agent's own repository credential is never read.
GitHub evidence comes from a local directory (Actions treated as enabled) or the
GitHub read API pinned to the branch's current commit. The runtime resolves which
cloud identity each deploy job uses, evaluating supported workflow expressions for
the branch. GCP evidence comes from a reader access token in a file the operator
names. Without it, identities are listed and marked as not assessed. Only GCP has
a reader adapter here; identities from other clouds are always listed, never
assessed.

## Proof scope

- **Unit tests** replay recorded GCP API response shapes through the production
  adapter and use sample workflow files. They prove the example's wiring, answers
  and exit codes, not provider behavior.
- **Emulator.** The runtime's own runner covers the GCP adapter against upstream
  Floci GCP 0.11.0 (service account, workload identity binding and project roles),
  where Policy Troubleshooter is unsupported.
- **Live GCP.** On November 3, 2026 the checker ran against a real service account
  with a keyless reader token: YES for an agent that may write `scripts/deploy.sh`,
  CLEAR for docs only. Policy Troubleshooter results were partial; see the README.
- **Not proven:** an executed GitHub Actions run, trigger and protection
  resolution, and the workload identity provider's attribute mapping and condition.
  There is no GitHub emulator; GitHub evidence is sample workflows plus read-only
  live runs.
