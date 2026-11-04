# Architecture

```
grants file (TypeScript)       workflow files                 GCP (reader access token)
  defineTool / createGrant      GitHub API or local dir        account + project IAM policies,
          |                           |                        Policy Troubleshooter
          v                           v                                 |
  createToolSession --> preflightTools -- githubPermissionPreflight -- { gcp: gcpWorkflowServiceAccountAssessor }
                              |              (workflowIdentity adapter)
                              v
                    report: github.workflow-execution
                    finding | clear | unknown, path, evidence, limits
                              |
                    admitToolSession --> admitted | blocked
                              |
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
include response bodies or either token. The runtime's decisions are unchanged.

The checker creates a tool session only to run preflight. Its credential
resolver always throws, so the agent's own repository credential is never read.
GitHub evidence comes from the GitHub read API, pinned to the branch's current
commit, with the token in `GITHUB_TOKEN`, or from a local directory (Actions
treated as enabled). `npm run demo` uses the GitHub API against a real public
repository. The runtime resolves which cloud identity each deploy job uses,
evaluating supported workflow expressions for the branch. GCP evidence comes from a
reader access token in a file the operator names. Without it, identities are listed
and marked as not assessed. Only GCP has a reader adapter here; identities from
other clouds are always listed, never assessed.

## Tests

The demo calls the real provider; only the tests use stand-ins, and they intercept
the provider calls rather than replace the code that makes them.

- **`npm run test:demo`** runs the `demo` command from `package.json` (same CLI,
  arguments and grants files) with `test/recorded-github.mjs` loaded first. That
  module replaces `fetch` with the GitHub API responses recorded from a live
  read-only demo run (`fixtures/demo-github-responses.json`: URL, status and body,
  no headers or token) and refuses any request without a recording. The test
  asserts the answers, that the requests are exactly the recorded ones, and that the
  README's output sample matches. `GITHUB_RECORD=1` with a real token records again.
- **Unit tests** (`test/check.test.ts`) use the sample `acme/functions` workflow and
  grants in `fixtures/functions`, and replay recorded GCP API response shapes
  through the production adapter.
- **`npm run test:package`** copies the folder outside the repository, installs the
  packed runtime, and runs the checks, the recorded demo, the build and the compiled
  CLI against the same recording.

## Proof scope

- **Live GitHub.** On November 4, 2026 the demo ran against
  `GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main`: YES for the
  broad grants, CLEAR for `README.md` only. See the README's evidence section.
- **Emulator.** The runtime's own runner covers the GCP adapter against upstream
  Floci GCP 0.11.0 (service account, workload identity binding and project roles),
  where Policy Troubleshooter is unsupported.
- **Live GCP.** On November 3, 2026 the checker ran against a real service account
  with a keyless reader token: YES for an agent that may write `scripts/deploy.sh`,
  CLEAR for docs only. Policy Troubleshooter results were partial; see the README.
- **Not proven:** an executed GitHub Actions run, trigger and protection
  resolution, and the workload identity provider's attribute mapping and condition.
  There is no GitHub emulator; the tests replay recorded GitHub responses.
