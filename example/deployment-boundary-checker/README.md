# Deployment boundary checker

"Can my coding agent change anything that runs with production credentials?" Run
this before you give an agent write access to a repository.

You list the files the agent may write. The checker reads the repository's GitHub
Actions workflows and asks II Agent Runtime's permission preflight whether a job
that holds deployment credentials runs any of those files. You get **YES**,
**CAN'T TELL** or **CLEAR**, with the path: which file, which job, and which cloud
identity that job uses. With a GCP reader token it also shows whether the service
account accepts the job and which roles it holds.

## Install

Clone this repository, install the runtime at its root, then install the example:

```sh
git clone https://github.com/intelligent-iterations/ii-agent-runtime.git
cd ii-agent-runtime
npm ci                  # installs and builds the runtime
cd example/deployment-boundary-checker
npm ci
```

Requirements: Node 22.16+, Git, npm and a GitHub token. The commands below take the
token from the [GitHub CLI](https://cli.github.com): `brew install gh`, then
`gh auth login`. Any token that can read public repositories also works in
`GITHUB_TOKEN`.

## See it work

```sh
GITHUB_TOKEN=$(gh auth token) npm run demo
```

The demo checks a real public repository: Google's
[Secret Manager provider for the Secrets Store CSI Driver](https://github.com/GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp),
branch `main`. Its `e2e` workflow signs in to Google Cloud without a key (workload
identity federation, `id-token: write`) as a service account, then runs
`test/infra/runner.sh`, which builds images with Cloud Build and runs test jobs on a
GKE cluster. The demo compares two agents:

- [`agents/broad.ts`](agents/broad.ts) may write `test/infra/runner.sh`, `main.go`,
  `Makefile` and `README.md`.
- [`agents/restricted.ts`](agents/restricted.ts) may write only `README.md`.

The checker only reads. It makes GitHub API GET requests for the branch's current
commit, its workflow files and its Actions settings, and it runs and changes nothing.
Results reflect the repository's workflows at the time you run it, so they change
if its maintainers change those workflows.

Output from the live run on November 4, 2026, trimmed (`...` marks left-out lines):

```text
Deployment boundary comparison

                                 broad                                   restricted
Writable files                   4                                       1
workflow-execution               FINDING                                 CLEAR
Identities on reported path      gh-e2e-runner@secretmanager-csi-build   -
Cloud actions on reported path   -                                       -
Preflight admission              blocked                                 admitted

=== broad ===
Deployment boundary check | agent:codex
Can this agent change anything that runs with deployment credentials?
  YES: a workflow job with deployment credentials runs a file this agent can write.
...
Inspected 3 workflow file(s) from GitHub GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main at commit 31170f58a4e9.
...
Path:
  1. contents.write GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main:test/infra/runner.sh
  2. GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main:.github/workflows/e2e.yml#e2e-test
  3. assumes gcp gh-e2e-runner@secretmanager-csi-build.iam.gserviceaccount.com via OIDC through projects/735463103342/locations/global/workloadIdentityPools/github-pool/providers/github-provider
  4. gcp authority not assessed (no credential designated)
...
Preflight admission: blocked

=== restricted ===
...
  NO RECOGNIZED PATH: no inspected workflow runs or references anything this agent can write.
...
Preflight admission: admitted

Narrowing the grants changed the result: FINDING -> CLEAR.

Note: without --gcp-token-file, GCP service accounts that deploy jobs use are listed but not assessed.
Note: Actions settings for GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp need admin access to read, so Actions is treated as enabled.
```

- **broad: YES.** The `e2e-test` job runs `test/infra/runner.sh` with the
  federated service account. `main.go` and `Makefile` are not cleared either, but
  the runner alone makes the answer YES.
- **restricted: CLEAR.** `README.md` is documentation, no workflow mentions it, and
  all three workflows use syntax the checker supports.
- The service account is listed, not assessed: that needs a GCP reader token with
  access to Google's project (see [step 3](#3-assess-gcp-service-accounts-optional)),
  which the demo does not have.
- Reading Actions settings needs admin access, so Actions is treated as enabled. That
  can only keep a YES or CAN'T TELL.

Without a token, the demo stops with exit code 64 and this line:

```text
GITHUB_TOKEN is not set: the demo reads the repository's workflows from GitHub with your token. Run: GITHUB_TOKEN=$(gh auth token) npm run demo
```

## Use it in your own repository

The checker runs from the clone against any repository. To keep it in your own
repository, copy this folder there from the clone's root and replace the runtime
dependency, which points at the clone (`file:../..`), with the GitHub repository:

```sh
cp -R example/deployment-boundary-checker /path/to/your-repo/
cd /path/to/your-repo/deployment-boundary-checker
npm install github:intelligent-iterations/ii-agent-runtime
```

npm builds the runtime and pins the exact commit in `package-lock.json`; later
installs use `npm ci`. The checker uses only the runtime's installed exports.

## Check a repository's workflows

### 1. Describe your agent

Grants files live in this folder's `agents/`. They import the runtime installed
here, so a grants file kept elsewhere fails to load. Start from the broad sample:

```sh
cp agents/broad.ts agents/mine.ts
```

Then edit `agents/mine.ts`:

```ts
import { createGrant, defineTool } from '@intelligent-iterations/ii-agent-runtime/runtime';
import { githubContents } from '@intelligent-iterations/ii-agent-runtime/tools';

const repository = 'your-org/your-app';
const subject = 'agent:codex';
const writeFile = defineTool({
  name: 'write-file',
  operation: githubContents().write,
  credential: { provider: 'github', resource: repository, key: 'app-agent-key', assignment: subject },
});

export default {
  subject,
  tools: [writeFile],
  grants: [createGrant({
    subject, tool: writeFile,
    resources: { repository: [repository], branch: ['main'], path: ['scripts/deploy.sh', 'src/index.ts', 'package.json', 'docs/guide.md'] },
  })],
};
```

- `repository` is `owner/name` on GitHub; `branch` is the branch the agent writes
  to. The checker reads that branch's workflows.
- `path` lists exact file paths, up to 256 per grant. Globs (`scripts/**`) and
  directories (`scripts/`) are rejected with a plain message.
- `credential` is a label `defineTool` requires. The checker never resolves or uses
  it. Its `resource` is your repository; `key` can be any name.

If your agent already runs on II Agent Runtime, copy its grants: the checker reads
the same `createGrant` resources the runtime enforces.

### 2. Run it

From GitHub, as the demo does. The calls are read-only and use the branch's current
commit:

```sh
GITHUB_TOKEN=$(gh auth token) npm start -- --grants agents/mine.ts --github
```

For a private repository, the token must be able to read it. From a local checkout,
with no network access:

```sh
npm start -- --grants agents/mine.ts --workflows /path/to/repo/.github/workflows
```

Add `--compare agents/other.ts` to see a second grants file side by side, `--report`
for the runtime's full preflight report, or `--json` for machine-readable results.

Each result says what it read, for example `Inspected 3 workflow file(s) from GitHub
GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main at commit
31170f58a4e9.` A directory or branch with no `.yml`/`.yaml` workflow files is an
error (exit 64), never a clear answer; if you pass a repository root, the checker
suggests its `.github/workflows`. It also warns when a local checkout's `origin` or
branch differs from the grants.

Reading Actions settings needs admin access. Without it, or for local files, the
checker treats Actions as enabled and prints a note. That can only keep a YES or
CAN'T TELL; a clear answer never depends on Actions being off.

### 3. Assess GCP service accounts (optional)

Without a reader token, service accounts are listed and marked `gcp authority not
assessed (no credential designated)`. To assess them, write a reader's OAuth access
token to a file only you can read, and pass its absolute path:

```sh
(umask 077; gcloud auth print-access-token > "$HOME/.gcp-reader-token")
npm start -- --grants agents/mine.ts --github --gcp-token-file "$HOME/.gcp-reader-token"
```

The file is read for each request and never printed. A relative path, a missing
file or an empty file exits 64 at startup. The reader needs:

- `iam.serviceAccounts.getIamPolicy` on each deploy service account;
- `resourcemanager.projects.getIamPolicy` on each account's home project;
- for provider-evaluated permissions, access for Policy Troubleshooter to read
  allow and deny policies, for example `roles/iam.securityReviewer` and
  `roles/iam.denyReviewer` on those projects.

The adapter reads the account's IAM policy and its home project's IAM policy, and
asks Policy Troubleshooter about eight fixed high-impact permissions. A read it
cannot make is reported as missing information, and a note gives the request's
HTTP status. With a reader, each "not assessed" step becomes the binding result and
the bound roles. From the unit tests, which replay recorded GCP responses for the
sample `acme/functions` workflow in [`fixtures/functions`](fixtures/functions):

```
  4. assumes gcp deployer@acme-functions-prod.iam.gserviceaccount.com via OIDC through projects/123456789/locations/global/workloadIdentityPools/github/providers/github
  5. service account bindings admit repo:acme/functions:ref:refs/heads/main
  6. gcp:roles/cloudfunctions.developer acme-functions-prod (declared in policy, not provider-evaluated)
```

Bound roles are listed as declared; only Policy Troubleshooter results are shown as
provider-evaluated.

## Reading the results

- **YES (finding), exit 1:** a job that holds credentials (OIDC `id-token: write`,
  write token permissions or secrets) checks out the repository and runs a file the
  agent can write. That can be a script it runs directly, or a manifest that a
  recognized `npm`, `make`, `docker build` or `pip install` step runs. Each such job
  is its own numbered path.
- **CLEAR (no recognized path), exit 0:** every writable file is documentation or
  static media (`.md`, `.txt`, images, ...), outside `.github/`, not a manifest tools
  load implicitly, and not mentioned by any job; every workflow parsed with
  supported syntax (see [Limits](#limits)).
- **CAN'T TELL (unknown), exit 2:** anything else. The deciding reason comes first.
  For example, granting only `main.go` in the demo repository gave, in the live run
  on November 4, 2026 (trimmed):

  ```
    CAN'T TELL: the evidence does not establish either answer.
  Why:
    - main.go may be run or loaded by repository code.
      Only documentation and static media (.md, .txt, images, ...) can be cleared; the check does not trace what repository code loads.
  ...
  Jobs that hold credentials (this check did not link them to the agent's files):
    1. GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main:.github/workflows/bump-chart-versions.yml#bump_charts_version
    2. GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp@main:.github/workflows/e2e.yml#e2e-test
       assumes gcp gh-e2e-runner@secretmanager-csi-build.iam.gserviceaccount.com via OIDC through projects/735463103342/locations/global/workloadIdentityPools/github-pool/providers/github-provider
  ```

  The listed jobs hold credentials (`bump_charts_version` has a write token); the
  check did not link them to the agent's files.

Exit 64 means a usage or configuration error. With `--compare`, the exit code
describes the compared file. Use the exit code as a gate in your own pipeline.

In the comparison table, "Identities on reported path" counts what each result
reports: for a finding, the jobs that run the agent's files; for can't tell, every
job that holds credentials. A narrower grant can therefore list more identities.

## Limits

- Clear covers execution of the agent's files by the inspected workflows. It does
  not cover data that scripts read, publishing the content (for example a docs
  site), workflows on other branches, or later workflow changes.
- Trigger filters, environment approvals, branch protections and custom OIDC
  subject claims are not resolved. The workload identity provider's attribute
  mapping and condition are not read.
- A service account from `secrets.*` or `vars.*`, or one set at run time through
  `GITHUB_ENV`, is reported as unresolved rather than guessed.
- Local actions (`uses: ./...`), reusable workflows, checkouts with `ref`,
  `repository` or `path`, and `working-directory` are unsupported syntax. Any of
  them in any workflow rules out a clear answer.
- This example assesses GCP service accounts only. Identities from other clouds are
  listed but not assessed.

## Evidence

**Live demo, November 4, 2026:** `GITHUB_TOKEN=$(gh auth token) npm run demo`
against `GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp`, branch `main`
at commit `31170f58a4e9`, with read-only GitHub API calls and no cloud credentials:

- `agents/broad.ts` got **YES**: the `e2e.yml#e2e-test` job federates to
  `gh-e2e-runner@secretmanager-csi-build.iam.gserviceaccount.com` and runs
  `test/infra/runner.sh`. The account was listed, not assessed.
- `agents/restricted.ts` (`README.md` only) got **CLEAR** and was admitted.
- `main.go` alone got CAN'T TELL.
- The Actions settings read returned HTTP 403 (it needs admin access), so Actions
  was treated as enabled.
- The same day, `npm run demo` from a throwaway workflow on a self-hosted macOS runner,
  with the workflow's own `GITHUB_TOKEN`, gave the same comparison: FINDING -> CLEAR.

That run's GitHub API responses (URL, status and body) are recorded in
[`fixtures/demo-github-responses.json`](fixtures/demo-github-responses.json), and
`npm run test:demo` replays them.

**Live GCP:** verified on November 3, 2026 against a real GCP project, with
`--gcp-token-file` holding a keyless (workload identity federation) token for a real
service account that holds `roles/iam.securityReviewer` on its home project. The
workflow inspected was a deploy workflow on a demo branch (analyzed, never run): on
a push to that branch, it federates to that account and runs `scripts/deploy.sh`. A
`--compare` of two grants files gave:

- An agent that may write `scripts/deploy.sh` got **YES**. The path ran from the
  script, to `deploy.yml#deploy`, to the account through the real pool provider. The
  account's live IAM policy admitted that repository and branch
  (`repo:<owner>/<repository>:ref:refs/heads/<branch>`), and its real
  `roles/iam.securityReviewer` binding was read from the project policy.
- An agent that may write only `docs/notes.md` got **CLEAR** and was admitted.

Policy Troubleshooter results were partial, because Deny Reviewer cannot be granted
on a single project. The checker reported that as missing information; it did not
guess. Run against the same repository's regular workflows, the same account showed
up as CAN'T TELL. Those workflows use syntax the checker reports as unsupported:
`working-directory`, and checkouts with `ref` or `path`.

**Live GitHub:** on November 2, a read-only `--github` run against the II Agent
Runtime repository's development branch returned can't tell for a script and
`package.json` (the CodeQL job holds write permissions) and clear for `README.md`
alone, which was still clear on November 3.

**Four private GCP-deploying repositories, November 2, 2026:** read-only `--github`
runs with no cloud credentials, a broad and a narrowed grant each:

| Repository | Broad grant | Result | Narrowed to `README.md` |
| --- | --- | --- | --- |
| A | `package.json` | **YES**: the deploy job runs `npm`, then assumes a production or a development service account (both listed: the project comes from a branch and dispatch expression); other jobs assume a third account | can't tell (unsupported syntax in other workflows) |
| B | a version-bump script | **YES**: a deploy job runs it, with a service account from `secrets.*` (unresolved) | can't tell (local composite action) |
| C | `package.json` | **YES**: the deploy job runs `pnpm install` and uses a long-lived key from `secrets.*` | **clear** |
| D | `package.json` | **YES**: one deploy job uses a long-lived key from `secrets.*`; another federates to a service account from `vars.*` (unresolved) | **clear** |

**Emulator and tests:** `npm run test:demo` runs the demo's own command with GitHub's
API replaced by the recorded responses above; a request with no recording is
refused. The unit tests replay recorded GCP response shapes through the production
adapter, with the sample `acme/functions` workflow. The runtime's own runner covers
the same GCP reads against the upstream Floci GCP 0.11.0 emulator, which does not
support Policy Troubleshooter. No GitHub Actions run was executed; GitHub evidence
is the read-only live runs above, their recorded responses and sample workflows.

## Verify

```sh
npm run check          # TypeScript + 23 tests: the recorded demo, sample agents, GCP adapter with recorded responses, GitHub reads, CLI exit codes, setup errors
npm run test:demo      # the demo's own command against the recorded GitHub responses: YES for broad, CLEAR for restricted, no network or token
GITHUB_TOKEN=$(gh auth token) npm run demo   # the live comparison above
npm run test:package   # packed runtime, copy outside the repository, install, checks, recorded demo, build, compiled CLI
```

If the live demo stops matching the recording because the repository's workflows
changed, `GITHUB_TOKEN=$(gh auth token) GITHUB_RECORD=1 npm run test:demo` checks
the live result and records it again. Then update the output above.

## Boundaries

| Example owns | Runtime owns |
| --- | --- |
| CLI, grants loading, local workflow reading, setup checks, failed-read notes, answer wording, comparison view, the tests' recorded GitHub and GCP responses | Grants model, GitHub workflow analysis and expression evaluation, GCP service account assessment, preflight report and admission |

There are no runtime source changes in this example. See
[architecture](ARCHITECTURE.md) for the flow and proof scope.
