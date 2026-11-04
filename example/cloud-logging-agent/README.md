# Cloud Logging errors for Codex

Ask Codex what failed in one Cloud Function or Cloud Run service recently. It
receives bounded error summaries, timestamps, entry IDs and Logs Explorer links.
II Agent Runtime holds the Google credential outside Codex and checks the exact
project and resource before resolving it. This example implements only Cloud
Logging `entries.list`; it has no mutation tool.

## Install

Clone this repository, install the runtime at its root, then install the example:

```sh
git clone https://github.com/intelligent-iterations/ii-agent-runtime.git
cd ii-agent-runtime
npm ci                  # installs and builds the runtime
cd example/cloud-logging-agent
npm ci
cp config.example.json config.json
```

Requirements: Node 22.16+, Git and npm, and a Google Cloud project with a Cloud Run
service or Cloud Function whose errors you want to read. To run Codex, use an
explicitly selected Linux execution host with local Docker, OpenTofu 1.8 or a later
1.x, `tar`, `sudo`, `iptables` and `ip6tables`. The runtime must be allowed to
manage its own Docker networks and firewall rules (`sudo --non-interactive`). A
dedicated disposable Linux host is recommended. This launcher does not silently run
Codex on your host shell. On macOS, `npm run start:linux` provides that Linux host
in a container on Docker Desktop or Colima; see [Run from macOS](#run-from-macos).

## Configure your service

`config.json` is git-ignored. It holds no secrets, so remove that line from
`.gitignore` in your copy if you want to commit it. Edit it:

- `project`: the Google Cloud project ID.
- `resourceType`: `cloud_function` (1st gen, label `function_name`) or
  `cloud_run_revision` (Cloud Run and 2nd gen functions, label `service_name`).
- `resource`: the exact function or service name, for example `checkout`. The CLI
  rejects the `YOUR_...` placeholders and names the field to edit.
- `logView` (optional): read through one [log view](https://cloud.google.com/logging/docs/logs-views)
  instead of the whole project, written as `locations/global/buckets/_Default/views/VIEW_ID`.
  Use it with a view-only identity (recommended, see below).
- `execution`: keep `local-linux-docker`; the example explicitly selects this target.
- `image`: the supplied digest-pinned Node image. The runtime installs the locked
  Codex and MCP dependencies before credentials or the gateway are available.
- `model`: a Codex-compatible model available to your OpenAI API project.
- The two model price fields: the model's input/output rate in micro-USD per
  million tokens (for example, $1 per million tokens is `1000000`). The prefilled
  `2000000` and `12000000` are `gpt-5.6-terra`'s list prices on November 3, 2026
  ($2/$12 per 1M input/output tokens). Check current prices, and change both rates
  if you change the model. Zero or missing rates fail validation. The gateway limits
  each run to 12 model requests and a $2 reservation at your configured rates; this
  is not an independently verified billing cap.

The query is fixed by the adapter, not the agent:

```
resource.type="<resourceType>" AND resource.labels.<label>="<resource>"
AND severity>=ERROR AND timestamp>="<start>" AND timestamp<"<end>"
```

You set the window with `--minutes`; Codex may ask for any window up to 7 days. It
cannot supply a filter, a different project or resource, an endpoint, or another
operation.

### Google credentials

Credentials come from [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
**on the trusted host only**, with the read-only `logging.read` scope. Any of:

```sh
# A dedicated service-account key file (outside this directory, under your home directory):
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/log-reader.json
# or keyless: workload identity federation config in the same variable
# or your user, impersonating a dedicated reader service account:
gcloud auth application-default login --impersonate-service-account=log-reader@PROJECT.iam.gserviceaccount.com
```

No credentials go in `config.json`. No host home directory or gcloud
configuration is mounted in the Codex container; the token is resolved per call
at the gateway and never sent anywhere but `logging.googleapis.com`.

Grant the identity only what this reads, as defense in depth:

- Simplest: `roles/logging.viewer` on the project. This can read every log in the
  project, so the gateway's exact grant is the only per-resource limit.
- Tighter (recommended): a log view on the `_Default` bucket filtered to the one
  resource, with `roles/logging.viewAccessor` granted on that view only. Google then
  enforces the same boundary as the gateway:

  ```sh
  PROJECT=your-project-id
  READER=log-reader@your-project-id.iam.gserviceaccount.com
  gcloud logging views create checkout-errors --bucket=_Default --location=global --project=$PROJECT \
    --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="checkout"'
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$READER" \
    --role=roles/logging.viewAccessor \
    --condition="expression=resource.name == \"projects/$PROJECT/locations/global/buckets/_Default/views/checkout-errors\",title=checkout-errors-only"
  ```

  For a 1st gen function, filter on `cloud_function` and `function_name` instead.
  Then set `"logView": "locations/global/buckets/_Default/views/checkout-errors"` in
  `config.json`, so every read names that view. A view-only identity's project-wide
  read returns HTTP 200 with only the view's entries, not an error: to check the
  view, read another resource's logs as that identity and confirm the result is empty.

Provisioning credentials and IAM is your application's setup responsibility, not
a runtime service. Never grant `roles/logging.privateLogViewer`: this reads
application error logs, not Data Access audit logs.

## See it work

```sh
npm run demo
```

The demo checks the boundary on your own service, with your own credentials and no
model. It makes the read Codex makes (your service's errors from the last 24 hours,
through the runtime gateway), then asks for another service and for a delete. Both
are denied by the gateway before Google is called. It needs no Docker and works on
macOS. Use `--minutes` for another window (up to 10080, 7 days). Output of a live run
on November 4, 2026, against a real Cloud Run service through its log view (the project
ID and the application's name replaced):

```text
Cloud Logging errors for Codex: boundary check on your service (no model)

Grant: cloudLoggingErrors → projects/my-project, cloud_run_revision service_name="api", read through locations/global/buckets/_Default/views/api-errors-demo

1. Read api's errors from the last 10080 minutes, the call Codex makes:
   42 ERROR-or-higher entries in 10 groups.
    13 x ERROR    app error captured (errorType: github_auth_failed)
         last 2026-10-30T15:44:05.674Z, insertId 6ae4bb45000a4b084d658d75
     8 x ERROR    HTTP 502 GET /api
         last 2026-10-30T15:44:04.850Z, insertId 6ae4bb45000849f4f1b92e08
     6 x ERROR    app error captured (errorType: interactive_sessions_unavailable)
         last 2026-10-30T19:37:56.065Z, insertId 6ae4f2140000fe02871288b3
     4 x ERROR    HTTP 503 GET /api
         last 2026-10-30T19:37:55.749Z, insertId 6ae4f213000c5c39987a3c02
     3 x ERROR    HTTP 500 POST /api
         last 2026-11-02T03:22:50.540Z, insertId 6ae802240005f07bfb137cfd
   ... and 5 more groups (npm start -- --read prints them all as JSON).

2. Read another service, "payments":
   Denied by the gateway grant (HTTP 403).

3. Delete a log:
   Denied (HTTP 403): the gateway exposes no write operation.

Google received 2 requests, all for the granted read; the two denied calls never left this host.
Next, let Codex read the same errors: npm start -- --minutes 1440 (Linux) or npm run start:linux -- --minutes 1440 (macOS).
```

It passed when step 1 lists your errors, steps 2 and 3 say Denied, and the command exits
0. The summary line is printed only when both denied calls stayed on your host. A read
can take more than one Google request when Google returns the entries in pages.

## Run Codex

`npm start -- --read --minutes 60` makes the same single read and prints the whole
bounded summary as JSON. It also works on macOS, because it launches no agent and
makes no sandbox claim.

On the configured Linux host, supply `OPENAI_API_KEY` to the trusted launcher and
run:

```sh
npm start -- --minutes 60
```

The launcher starts an isolated Codex CLI, exposes `cloudLoggingErrors` through
MCP, and prints Codex's answer. Google and model credentials remain in the
gateway; Codex receives a short-lived gateway token. The runtime restricts worker
egress to that gateway. Runs end after 15 minutes and clean up their container,
network and firewall rules. Cleanup failures are reported as failures.

### Run from macOS

```sh
export OPENAI_API_KEY=...
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/log-reader.json
npm run start:linux -- --minutes 60
```

`start:linux` compiles the example, builds `linux-host/Dockerfile` once (Node 22,
Docker CLI, OpenTofu and iptables, all digest-pinned) and runs the same CLI inside
it. The runtime then creates the Codex worker, its network and its firewall rules in
Docker's Linux VM, as it would on a Linux host. Only `OPENAI_API_KEY` and the
`GOOGLE_APPLICATION_CREDENTIALS` file are passed into the container. With
`gcloud auth application-default login`, that file is
`$HOME/.config/gcloud/application_default_credentials.json`.

- Keep the project and the credential file under your home directory. Docker Desktop
  and Colima share only that with their VM by default, and the container uses the same
  paths as your Mac. `start:linux` stops with one line if either is elsewhere. If you
  shared another directory with Docker yourself, list it in `DOCKER_SHARED_DIRS`
  (colon-separated).
- In a clone of this repository the runtime is a link to the clone's root, so
  `start:linux` also mounts that root, read-only, at the same path.
- The container controls your Docker daemon (through its socket) and the VM's firewall
  (`NET_ADMIN`). Use it only where you already trust Docker with that.
- `npm run test:isolation:linux` runs the isolation probe the same way.

`--project` and `--resource` change the request, not the trusted grant. Try one
to see a real denial:

```sh
npm start -- --read --resource payments --minutes 60
# Request denied by the gateway grant (HTTP 403). No credential resolution or API request.
```

Codex sees only the gateway's HTTP status: 403 for a grant denial, 502 when the
upstream call failed. The trusted host's stderr gets the reason as one line, for
example `Google credentials unavailable: Could not load the default credentials...`,
`Cloud Logging request failed (HTTP 403)` or `Cloud Logging endpoint unreachable
(ECONNREFUSED)`. It never includes tokens, headers or credential file contents.

## Use it in your own repository

You can run it from the clone. To keep it in your own repository, copy this folder
there from the clone's root and replace the runtime dependency, which points at the
clone (`file:../..`), with the GitHub repository:

```sh
cp -R example/cloud-logging-agent /path/to/your-repo/
cd /path/to/your-repo/cloud-logging-agent
npm install github:intelligent-iterations/ii-agent-runtime
```

npm builds the runtime and pins the exact commit in `package-lock.json`; later
installs use `npm ci`. The example uses only the runtime's installed exports.

## Verify

The CLI always calls `logging.googleapis.com`; it has no emulator setting. The tests
run the same code with its outgoing Google requests intercepted:

```sh
npm run check          # TypeScript + gateway, CLI, demo and config tests; Google requests go to local HTTP fixtures
npm run test:demo      # Docker: the real demo and read path, Google requests redirected to upstream floci-gcp
npm run test:package   # packed runtime, copy outside the repo, install, checks, build, CLI, test:demo
npm run test:isolation # Linux Docker host: real runtime firewall/container probes
npm run test:isolation:linux  # the same probe from macOS (Docker Desktop or Colima)
```

The interception (`test/intercept-google.ts`) is a `fetch` that sends each Cloud
Logging request the adapter builds to a local server or to the emulator, and fails
any other request. The unit fixtures follow the documented `entries.list` response
shape; they are not live captures. `test:demo` uses the independent
[floci-gcp](https://hub.docker.com/r/floci/floci-gcp) image the runtime's GCP proof
already pins. It seeds 12 entries for a sample Cloud Run service `checkout` (7 errors
in scope, plus INFO and WARNING entries, an error from two days ago, another service
and another project), runs `npm run demo`'s code and `--read` against them, and
verifies:

- exactly the 7 in-scope entries come back, in 4 groups
- another service and another project are denied with 403
- a delete request is denied with 403
- denied requests never reach the emulator or resolve a credential
- the written entries still exist afterwards

It removes its container. There is no Google-maintained Cloud Logging emulator.
floci-gcp does not apply the `resource.labels` filter clause: it returned the
other service's error for the exact query, and the adapter's local scope check
removed it. The adapter keeps that check for live Google too. floci-gcp has no log
views, so `logView` is covered by the unit tests and the live run only.

## Boundaries and limitations

| Example owns | Runtime owns |
| --- | --- |
| Cloud Logging HTTP adapter, query, error grouping, prompts, MCP client, configuration, credential instructions | Exact tool grants, credential resolution boundary, HTTP gateway, model mediation, Docker/OpenTofu target and network isolation |

The runtime is a dependency. It knows nothing about Cloud Logging, error
summaries or this CLI. There are no runtime source changes.

This custom read adapter has **no Cloud Logging provider-aware escalation
inspector**. Preflight reports unknown coverage. The example treats that check
as advisory and does not invent a clear result. Gateway grants remain mandatory.

Only entries with severity ERROR or higher are read. Errors an application logs
at lower severity are missed. Each request covers at most 7 days, 10 pages and
500 entries, with the top 10 grouped messages and up to 3 references each. Counts
describe the retrieved sample, not a service-wide error rate. Truncation is
reported.

Log content is untrusted and may contain sensitive application data. Authorized
log results can be sent to the selected model. Credential isolation does not make
logs safe to share, prove every secret is redacted, or turn prompt instructions
into enforcement. The sandbox, gateway and trusted adapter enforce the boundary,
including when a caller bypasses the MCP shim.

Live Google IAM behavior requires your credentials; the emulator does not
establish it. See [architecture](ARCHITECTURE.md) for the proof requirements.

## Evidence

Verified on November 4, 2026, from a throwaway workflow on a self-hosted macOS runner
with Colima, signed in keylessly (workload identity federation) as a service account that
can read only one Cloud Run service's log view. `npm run demo -- --minutes 10080` read
that service's 42 ERROR entries in 10 groups through the view, Google received 2
requests, both for the granted read, and another service and a delete were denied by
the gateway. `npm run start:linux -- --minutes 10080` then ran Codex with
`gpt-5.6-terra` in the isolated worker, which summarized the same 42 entries in 10
groups with insertIds.

Verified on November 3, 2026 against a real Cloud Run service, on macOS with Colima,
with a keyless service account that can read only that service's log view (workload
identity federation; only `roles/logging.viewAccessor` on a view of that service).
`npm start -- --read --minutes 10080` returned that service's 42 ERROR entries in 10
groups through the view. `npm run start:linux -- --minutes 10080` ran Codex with
`gpt-5.6-terra` in the isolated worker, which summarized the same 42 entries with
insertIds. `--resource` for another service was denied with HTTP 403 by the gateway.
Google itself returned no other resource's logs to that account. Earlier runs on the
same data showed three fixes since applied:
- request-only entries now read as `HTTP <status> <method> <path>`;
- generic messages include an `errorType` or `code`;
- a transient Google HTTP 500, and a transient sign-in error, are retried once.

`npm run test:isolation` passed on Linux on November 2, 2026 (a privileged
supervisor container on Docker 29.2.1 with OpenTofu 1.12.6; the agent worker itself
was non-root and unprivileged), with Docker and firewall state compared against a
baseline, and `npm run test:isolation:linux` passed on macOS with Colima on
November 3. `npm run check` (14 tests) and `npm run test:demo` passed on macOS with
Colima on November 4.

API references: [Cloud Logging entries.list](https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list),
[Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language),
and [Codex MCP configuration](https://developers.openai.com/codex/mcp).
