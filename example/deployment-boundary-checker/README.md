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
npm run demo
```

Requirements: Node 22.16+, Git and npm.

## See it work

`npm run demo` needs nothing beyond the install: no cloud account, token or network.
It checks two sample agents against a sample
[`acme/functions` deploy workflow](fixtures/functions/workflows/deploy.yml):

- [`agents/broad.ts`](agents/broad.ts) may write the deploy script, application
  code, `package.json` and a doc.
- [`agents/restricted.ts`](agents/restricted.ts) may write only `docs/guide.md`.

Output, trimmed:

```
Deployment boundary comparison

                                 broad                                                          restricted
Writable files                   4                                                              1
workflow-execution               FINDING                                                        CLEAR
Identities on reported path      deployer@acme-functions-prod, deployer@acme-functions-dev +1   -
Cloud actions on reported path   -                                                              -
Preflight admission              blocked                                                        admitted

=== broad ===
Deployment boundary check | agent:codex
Can this agent change anything that runs with deployment credentials?
  YES: a workflow job with deployment credentials runs a file this agent can write.
...
Path 1:
  1. contents.write acme/functions@main:scripts/deploy-functions.sh
  2. contents.write acme/functions@main:package.json
  3. acme/functions@main:.github/workflows/deploy.yml#functions
  4. assumes gcp deployer@acme-functions-prod.iam.gserviceaccount.com via OIDC through projects/123456789/locations/global/workloadIdentityPools/github/providers/github
  5. gcp authority not assessed (no credential designated)
  6. assumes gcp deployer@acme-functions-dev.iam.gserviceaccount.com via OIDC through projects/123456789/locations/global/workloadIdentityPools/github/providers/github
  7. gcp authority not assessed (no credential designated)
Path 2:
  1. contents.write acme/functions@main:package.json
  2. acme/functions@main:.github/workflows/deploy.yml#hosting
  3. uses a long-lived gcp key from secrets.HOSTING_SA_KEY (identity unresolved)
...
=== restricted ===
Deployment boundary check | agent:codex
Can this agent change anything that runs with deployment credentials?
  NO RECOGNIZED PATH: no inspected workflow runs or references anything this agent can write.
...
Narrowing the grants changed the result: FINDING -> CLEAR.

Note: without --gcp-token-file, GCP service accounts that deploy jobs use are listed but not assessed.
Note: local workflow files carry no Actions settings, so Actions is treated as enabled.
```

The sample workflow shows the three ways a GitHub Actions job gets GCP credentials,
and the checker keeps them apart:

- `functions` federates without a key (workload identity federation) to
  `deployer@${{ env.PROJECT }}.iam.gserviceaccount.com`. The project comes from an
  expression, so the runtime evaluates it for runs on `main`, including each
  `workflow_dispatch` choice, and lists both accounts.
- `hosting` reads a long-lived key from `secrets.HOSTING_SA_KEY`. It is named by its
  source and flagged: a stored key is not bound to the repository, and the workflow
  does not say whose it is.
- A service account named through `${{ secrets.* }}` or `${{ vars.* }}` is listed as
  unresolved with that reference, never guessed.

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

const subject = 'agent:codex';
const writeFile = defineTool({
  name: 'write-file',
  operation: githubContents().write,
  credential: { provider: 'github', resource: 'acme/functions', key: 'functions-agent-key', assignment: subject },
});

export default {
  subject,
  tools: [writeFile],
  grants: [createGrant({
    subject, tool: writeFile,
    resources: { repository: ['acme/functions'], branch: ['main'], path: ['scripts/deploy-functions.sh', 'src/index.ts', 'package.json', 'docs/guide.md'] },
  })],
};
```

- `repository` is `owner/name` on GitHub; `branch` is the branch the agent writes
  to. The checker reads that branch's workflows.
- `path` lists exact file paths, up to 256 per grant. Globs (`scripts/**`) and
  directories (`scripts/`) are rejected with a plain message.
- `credential` is a label `defineTool` requires. The checker never resolves or uses
  it. Set `resource` to your repository; `key` can be any name.

If your agent already runs on II Agent Runtime, copy its grants: the checker reads
the same `createGrant` resources the runtime enforces.

### 2. Run it

From a local checkout, with no network access:

```sh
npm start -- --grants agents/mine.ts --workflows /path/to/repo/.github/workflows
```

From GitHub, which also reads the repository's Actions settings (read-only calls):

```sh
GITHUB_TOKEN=$(gh auth token) npm start -- --grants agents/mine.ts --github
```

Add `--compare agents/other.ts` to see a second grants file side by side, `--report`
for the runtime's full preflight report, or `--json` for machine-readable results.

Each result says what it read, for example `Inspected 1 workflow file(s) from
fixtures/functions/workflows.` A directory or branch with no `.yml`/`.yaml`
workflow files is an error (exit 64), never a clear answer; if you pass a
repository root, the checker suggests its `.github/workflows`. It also warns when a
local checkout's `origin` or branch differs from the grants.

Reading Actions settings needs admin access. Without it, or for local files, the
checker treats Actions as enabled and prints a note. That can only keep a YES or
CAN'T TELL; a clear answer never depends on Actions being off.

### 3. Assess GCP service accounts (optional)

Without a reader token, service accounts are listed and marked `gcp authority not
assessed (no credential designated)`. To assess them, write a reader's OAuth access
token to a file only you can read, and pass its absolute path:

```sh
(umask 077; gcloud auth print-access-token > "$HOME/.gcp-reader-token")
npm start -- --grants agents/mine.ts --workflows /path/to/repo/.github/workflows --gcp-token-file "$HOME/.gcp-reader-token"
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
the bound roles. From the tests' recorded GCP responses:

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
  For example, granting only `src/index.ts` in the sample gives:

  ```
    CAN'T TELL: the evidence does not establish either answer.
  Why:
    - src/index.ts may be run or loaded by repository code.
      Only documentation and static media (.md, .txt, images, ...) can be cleared; the check does not trace what repository code loads.
  ```

  The jobs listed after it hold credentials; the check did not link them to the
  agent's files.

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
- This example assesses GCP only: AWS roles in a workflow are listed but not assessed.

## Evidence

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

**Emulator and tests:** the tests replay recorded GCP response shapes through the
production adapter. The runtime's own runner covers the same reads against the
upstream Floci GCP 0.11.0 emulator, which does not support Policy Troubleshooter. No
GitHub Actions run was executed; GitHub evidence is sample workflows plus the
read-only live runs above.

## Verify

```sh
npm run check          # TypeScript + 19 tests: sample agents, GCP adapter with recorded responses, GitHub reads, CLI exit codes, setup errors
npm run demo           # the comparison above
npm run test:package   # packed runtime, copy outside the repository, install, checks, demo, build, compiled CLI
```

## Boundaries

| Example owns | Runtime owns |
| --- | --- |
| CLI, grants loading, local workflow reading, setup checks, failed-read notes, answer wording, comparison view | Grants model, GitHub workflow analysis and expression evaluation, GCP service account assessment, preflight report and admission |

There are no runtime source changes in this example. See
[architecture](ARCHITECTURE.md) for the flow and proof scope.
