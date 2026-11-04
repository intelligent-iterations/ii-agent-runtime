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
npm run demo
```

Requirements: Node 22.16+, Git and npm; `npm run demo` also needs Docker. To run
Codex, use an explicitly selected Linux execution host with local Docker, OpenTofu
1.8 or a later 1.x, `tar`, `sudo`, `iptables` and `ip6tables`. The runtime must be allowed to
manage its own Docker networks and firewall rules (`sudo --non-interactive`). A
dedicated disposable Linux host is recommended. This launcher does not silently run
Codex on your host shell. On macOS, `npm run start:linux` provides that Linux host in a container on Docker
Desktop or Colima; see [Run from macOS](#run-from-macos).

## See it work (no Google account)

`npm run demo` needs only Docker. It starts the upstream
[floci-gcp](https://hub.docker.com/r/floci/floci-gcp) emulator and seeds 12 log entries:
7 ERROR/CRITICAL entries with 4 different messages from a sample Cloud Run service
`checkout`, plus INFO and WARNING entries, an error from two days ago, another service
and another project. It then runs the real CLI read path (`npm start -- --read`)
through the runtime gateway, shows one denial, and removes the container and its
volume, also on failure or Ctrl-C. No model or Google credentials are used.
Abridged output:

```text
Seeded 12 entries at http://127.0.0.1:32811:
  7 ERROR/CRITICAL entries from Cloud Run service "checkout" in project ii-demo-shop, in the last 40 minutes;
  plus INFO and WARNING entries, an error from 2 days ago, service "payments" and project ii-demo-ledger.

1. npm start -- --read --minutes 60, with this config.json:
{"project":"ii-demo-shop","resourceType":"cloud_run_revision","resource":"checkout","emulatorEndpoint":"http://127.0.0.1:32811"}

Grant: cloudLoggingErrors → projects/ii-demo-shop, cloud_run_revision service_name="checkout"
EMULATOR MODE: Cloud Logging at http://127.0.0.1:32811; no Google credentials are used.
Provider preflight: unknown (no Cloud Logging inspector); grant enforcement is active.
{
  "errors": [
    {
      "count": 3,
      "firstSeen": "2026-11-03T12:55:06.027Z",
      "lastSeen": "2026-11-03T13:14:06.027Z",
      "message": "Stripe API timeout after 10000 ms (POST /v1/payment_intents)",
      "references": [
        {
          "insertId": "a51f9ad4-29b8-4f53-a872-2db22bb4d945",
          "timestamp": "2026-11-03T13:14:06.027Z",
          "url": "https://console.cloud.google.com/logs/query;query=insertId%3D%22a51f9ad4-..."
        }, ...
      ],
      "severity": "ERROR"
    },
    { "count": 2, "message": "Inventory read failed: 4 DEADLINE_EXCEEDED: Deadline exceeded after 5.000s (sku book-1)", ... },
    { "count": 1, "message": "Unhandled rejection: TypeError: Cannot read properties of undefined (reading 'priceCents') ...", "severity": "CRITICAL", ... },
    { "count": 1, "message": "Webhook signature verification failed: no signatures found matching the expected signature", ... }
  ],
  "matchedEntries": 7,
  "truncated": false, ...
}

2. npm start -- --read --minutes 60 --resource payments
Request denied by the gateway grant (HTTP 403): only projects/ii-demo-shop, service_name="checkout" is allowed

The gateway returned 7 in-scope errors in 4 groups and denied another service without contacting Cloud Logging.
Removed the emulator and its volume. To keep it running for a live Codex run: npm run demo -- --keep
```

To try the live Codex run without Google access, run `npm run demo -- --keep`. It
leaves the seeded emulator running and prints the `config.json` lines to use,
including `emulatorEndpoint`, and the `docker rm -f -v ...` command that stops it. With
`emulatorEndpoint` set, the live run (`npm start` on Linux, `npm run start:linux` on
macOS) reads the emulator instead of Google. It still needs `OPENAI_API_KEY`.

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

## Configure your service

```sh
cp config.example.json config.json
```

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

Codex can choose the time window (up to 7 days). It cannot supply a filter, a
different project or resource, an endpoint, or another operation.

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
    --log-filter='resource.type="cloud_function" AND resource.labels.function_name="checkout"'
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$READER" \
    --role=roles/logging.viewAccessor \
    --condition="expression=resource.name == \"projects/$PROJECT/locations/global/buckets/_Default/views/checkout-errors\",title=checkout-errors-only"
  ```

  Then set `"logView": "locations/global/buckets/_Default/views/checkout-errors"` in
  `config.json`, so every read names that view. In a live test (below), a view-only
  identity asking Google directly, without the gateway, for any other resource's logs
  got none, both through the view and project-wide. Its project-wide reads returned
  only the view's entries.

Provisioning credentials and IAM is your application's setup responsibility, not
a runtime service. Never grant `roles/logging.privateLogViewer`: this reads
application error logs, not Data Access audit logs.

## Retrieve errors

Check your real Google connection without a model:

```sh
npm start -- --read --minutes 60
```

This runs the same tool through the real runtime HTTP gateway and prints the
bounded structured summary. It works on macOS because it launches no agent and
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

## Verify without Google credentials

```sh
npm run check          # TypeScript + real gateway, CLI and config tests with HTTP fixtures
npm run demo           # Docker + upstream floci-gcp; seeded logs through the real CLI
npm run test:emulator  # Docker + upstream floci-gcp; real Logging API calls; no model
npm run test:package   # packed runtime, copy outside the repo, install, checks, build, CLI, demo
npm run test:isolation # Linux Docker host: real runtime firewall/container probes
npm run test:isolation:linux  # the same probe from macOS (Docker Desktop or Colima)
```

The unit fixtures follow the documented `entries.list` response shape; they are
not live captures. The emulator test uses the independent
[floci-gcp](https://hub.docker.com/r/floci/floci-gcp) image the runtime's GCP proof
already pins. It raises an actual local checkout exception, writes it with
`entries:write`, retrieves it through the runtime gateway, and verifies:

- INFO entries and entries outside the window are excluded
- another function and another project are denied with 403
- a delete request is denied with 403
- denied requests never resolve a credential
- the written entries still exist afterwards

It removes its container. There is no Google-maintained Cloud Logging emulator.
floci-gcp does not apply the `resource.labels` filter clause: it returned the
other function's error for the exact query, and the adapter's local scope check
removed it. The adapter keeps that check for live Google too.

For an emulator-backed run of the real CLI, set `emulatorEndpoint` in
`config.json`, as `npm run demo -- --keep` prints it. The CLI then prints
`EMULATOR MODE` and uses no Google credentials. floci-gcp has no log views, so
`logView` is ignored there, with a notice.

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

Verified on November 2, 2026: `npm run check` (11 tests as of November 3), `npm run test:emulator`
against floci-gcp, `npm run test:package`, and `npm run test:isolation` on Linux
(a privileged supervisor container on Docker 29.2.1 with OpenTofu 1.12.6; the
agent worker itself was non-root and unprivileged), with Docker and firewall
state compared against a baseline. No Google credentials were used.

Live model run on November 2, 2026, with **emulated Cloud Logging**: the unmodified
CLI (`npm start -- --minutes 60`) ran on Linux in the same supervisor setup with
`gpt-5.6-terra` through the runtime model gateway and `emulatorEndpoint` pointing at
floci-gcp. The emulator held 13 entries: 7 in scope, plus INFO and WARNING entries,
an entry from two days earlier, another function and another project. Codex
called `cloudLoggingErrors`, received exactly the 7 in-scope entries and summarized
them as Stripe timeouts (3), inventory read deadlines (2), one CRITICAL unhandled
`priceCents` rejection and one webhook signature failure, with insertIds. A CLI
read of another function returned HTTP 403. This establishes actual model and
Codex behavior with this tool, not Google IAM or live data.

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

macOS newcomer path on November 3, 2026 (Colima, Docker 29.2.1):
this folder was copied out of the repository into its own Git repo, then `npm ci`,
`npm run check` (11 tests), `npm run demo`, `npm run demo -- --keep`, the printed
settings added to `config.example.json` as `config.json`, and
`npm run start:linux -- --minutes 1440` with `gpt-5.6-terra`. Codex reported exactly
the 7 seeded `checkout` errors in 4 groups, with insertIds; `--resource payments`
was denied with HTTP 403, and Docker returned to its starting container count.
`npm run test:isolation:linux` also passed on that Mac.

API references: [Cloud Logging entries.list](https://cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list),
[Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language),
and [Codex MCP configuration](https://developers.openai.com/codex/mcp).
