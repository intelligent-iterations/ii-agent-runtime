# Safe subagent handoff

A read-only **planner** agent investigates a failing test and hands a precise fix to a
**coder** agent, which edits the code and runs the test. Before anything runs,
II Agent Runtime analyzes the declared agents and warns that the planner can
indirectly reach the coder's write access through the handoff. Narrowing the coder's
grants shrinks that reachable authority without breaking the handoff.

- Both agents are small local TypeScript processes driven by a real OpenAI model. They
  see only a gateway endpoint and token; every model request and tool call goes through
  the runtime gateway, and your API key stays in the supervisor process.
- The planner has no write tool. The coder can write only the files the planner named,
  and only if they are inside the coder's configured bound. Anything else is HTTP 403.
- The same `invokers` declaration that the analysis reads also routes the handoff, so
  the warning describes the wiring that actually runs.

## Install

Clone this repository, install the runtime at its root, then install the example:

```sh
git clone https://github.com/intelligent-iterations/ii-agent-runtime.git
cd ii-agent-runtime
npm ci                  # installs and builds the runtime
cd example/subagent-handoff
npm ci
```

Requirements: Node 22.16+, Git and npm. The demo needs an OpenAI API key (next
section); the tests and the analysis mode need none.

## See it work

`npm run demo` runs the planner and the coder on the OpenAI API, on temporary copies of
the bundled `sample/` project (a cart whose total ignores item quantity): once with a
broad coder and once with a restricted one. It uses the model and prices in
`config.example.json` (`gpt-5.6-terra`, $2/$12 per million tokens) and your key:

```sh
export OPENAI_API_KEY=...   # create one at https://platform.openai.com/api-keys
npm run demo
```

**Cost: at most $4 per run.** The demo makes four agent runs (planner and coder, in
each of the two setups). Each gets its own model gateway, limited to 16 model requests
and a $1 reservation at the configured rates: 2 x 2 x $1. At these rates, 16 requests at
the per-request maximum (64,000 input and 4,000 output tokens) would reserve $2.82, so
the $1 limit is what binds. Every request reserves its counted input plus up to 4,000
output tokens and is never refunded. This is the gateway's limit, not an independently
verified billing cap. The demo prints the ceiling first and OpenAI's reported usage last.

Model output varies between runs, so the demo checks outcomes, not text: in both setups
the test script goes from exit 1 to exit 0; with the restricted coder's token, every
write outside its grant is refused with HTTP 403 and leaves the file unchanged; and the
restricted coder leaves the planner fewer reachable files than the broad one. If any
check fails, the demo says which and exits 1. Output of a live run on November 4, 2026
(abridged; the model's curly quotes made straight):

```text
OpenAI model gpt-5.6-terra at $2.00 input / $12.00 output per 1M tokens. Each of the 4 agent runs is limited to 16 requests and $1.00, so this demo costs at most $4.00.

== Broad setup: the coder may write every project file ==
  ! Based on declarations, planner can potentially activate coder via handoff-to-coder; write-file is indirectly reachable (declared).
  Reachable through the coder: write-file on 4 file(s) [package.json, src/cart.js, src/currency.js, test/cart.test.js]; run-script [test]
  ...
Handoff: handoff.task.created -> coder; files [src/cart.js]
...
Test script: exit 1 before, exit 0 after.

== Restricted setup: the coder may write only src/ files ==
  Reachable through the coder: write-file on 2 file(s) [src/cart.js, src/currency.js]; run-script [test]
Planner (read-only):
    run-script test -> HTTP 200, exit 1
    list-files  -> HTTP 200
    read-file package.json -> HTTP 200
    read-file src/cart.js -> HTTP 200
    read-file test/cart.test.js -> HTTP 200
    read-file src/currency.js -> HTTP 200
    handoff-to-coder src/cart.js -> HTTP 200
Handoff: handoff.task.created -> coder; files [src/cart.js]
Coder (write-file narrowed to [src/cart.js] of 2 configured):
    read-file src/cart.js -> HTTP 200
    write-file src/cart.js -> HTTP 200
    run-script test -> HTTP 200, exit 0
Gateway check with the coder's token:
    write-file package.json -> HTTP 403 (file unchanged)
    write-file src/currency.js -> HTTP 403 (file unchanged)
    write-file test/cart.test.js -> HTTP 403 (file unchanged)
Test script: exit 1 before, exit 0 after.
Planner's reply: The failure is in `cartTotal`: it sums unit prices but ignores each item's `quantity`, producing 350 instead of 600 cents.
    ...
Coder's reply: Updated `src/cart.js` so `cartTotal` multiplies each item's `priceCents` by its `quantity` before summing.
    ...

Demo checks (model output varies; these outcomes must hold):
  PASS Test script exit before -> after: broad 1 -> 0, restricted 1 -> 0 (expected 1 -> 0)
  PASS Writes outside the restricted coder's grant: 3 of 3 denied with HTTP 403, files unchanged
  PASS Files the planner can indirectly get written: 4 broad, 2 restricted (expected fewer when restricted)

Restricting the coder cut the files the planner can indirectly get written from 4 to 2. The handoff still fixed the test (exit 0).
Model use reported by OpenAI: 24 request(s) from 4 agent run(s), 26,984 input tokens (15,543 cached), 1,126 output tokens: at most $0.07 at the configured rates; the gateways reserved $1.21.
```

Without a key you can still run the cross-agent analysis on the bundled sample. It
starts no agent:

```sh
npm start -- --config config.example.json --analyze
```

```text
Project /path/to/subagent-handoff/sample: 4 file(s) visible to the agents (hidden, key, dependency and build files excluded).
Cross-agent analysis (runtime analyzeInvocations; based on declarations, not exhaustive):
  ! Based on declarations, planner can potentially activate coder via handoff-to-coder; write-file is indirectly reachable (declared).
  Planner's own write grants: 0
  Reachable through the coder: write-file on 2 file(s) [src/cart.js, src/currency.js]; run-script [test]
```

## Use it in your own repository

You can run it from the clone. To keep it elsewhere, for example in a tools
repository or next to your project, copy this folder there from the clone's root and
replace the runtime dependency, which points at the clone (`file:../..`), with the
GitHub repository:

```sh
cp -R example/subagent-handoff /path/to/tools/
cd /path/to/tools/subagent-handoff
npm install github:intelligent-iterations/ii-agent-runtime
```

npm builds the runtime and pins the exact commit in `package-lock.json`; later
installs use `npm ci`. The example uses only the runtime's installed exports.

Keep it **outside** the project you want it to work on. Inside the project, the
agents would see the example's own files and your test runner would pick up its
sample tests, so the CLI refuses that layout.

## Point it at your project

```sh
cp config.example.json config.json
```

Edit `config.json`:

- `project`: path to the project, relative to `config.json` or absolute. It needs a
  `package.json`.
- `task`: what the planner should investigate.
- `testScript`: the npm script both agents may run (default `test`). It must exist in
  the project's `package.json`.
- `coderWritablePaths`: the exact files the coder may ever edit, for example your
  source files but not tests, `package.json` or tool configs. Exact paths only; no
  globs or directories. The planner names files per task, and the coder gets only the
  named files that are inside this list.
- `model` and the two price fields: an OpenAI model and its input/output rate in
  micro-USD per million tokens ($1 per million tokens is `1000000`). The example
  config uses `gpt-5.6-terra` at its list price on November 3, 2026, $2/$12 per
  million tokens. Check current prices, and change both rates if you change the model.
  The per-agent limits under "See it work" apply at your rates, so a run on your
  project (one planner, one coder) costs at most $2 at the example rates. Use the
  model's real rates: inflated rates stop a run early with
  `Model gateway refused a request: Model cost limit reached`. To run the demo with
  your model and rates, use `npm run demo -- --config config.json`.

`config.json` is git-ignored here. It holds no secrets, so remove that line from
`.gitignore` in your copy if you want to commit it. The CLI checks the whole file and
lists every problem at once.

**What the agents can read:** every file `--analyze` counts, and its contents go to
the model provider. Hidden files and folders anywhere (`.env`, `.git`, `.github`),
key files (`*.pem`, `*.key`, `*.p12`, `*.pfx`), `node_modules`, `dist` and `coverage`
are never listed, read or written. Move other secrets out of the project first.

Check the cross-agent analysis first. This starts no agent and needs no key:

```sh
npm start -- --config config.json --analyze
npm start -- --config config.json --analyze --broad   # compare with an unrestricted coder
```

Then run it with your key on this trusted host only:

```sh
export OPENAI_API_KEY=...
npm start -- --config config.json
```

The key stays in the supervisor process. The runtime's OpenAI Responses adapter
(`executionServices.codexModelGateway`) forwards each agent's model request from its
gateway; agent processes start with only `PATH` in their environment. The coder edits
your project **in place**, so use a clean Git working tree and review the diff. If
`project` is still `./sample`, that is the bundled sample: restore it afterwards (for
example `git checkout -- sample`), or the demo finds nothing to fix.

## Verify

```sh
npm run check          # TypeScript + all tests: analysis, routing, real gateway denials, handoffs, test:demo
npm run test:demo      # the demo with its OpenAI calls answered by a test double; no key, no cost
npm run test:package   # packed runtime, copy outside the repo: install, check, build, compiled CLI and demo test
```

None of these needs a key or calls OpenAI. `npm run test:demo` runs the same `runDemo`
call as `npm run demo`, through the runtime's OpenAI adapter and its limits. Only the
adapter's HTTP calls to `api.openai.com` are intercepted: a scripted planner and coder in
`test/scripted-model.ts` answer them. The test also checks that the demo reports a
failure when the handoff does not fix the test, and the missing-key message. It shows
the wiring and the checks work, not how a real model behaves.

## How it works

| Piece | Where |
| --- | --- |
| Tools (`list-files`, `read-file`, `write-file`, `run-script`, `handoff-to-coder`) | `src/workspace.ts`, defined with `defineTool` |
| Grants, invoker declarations, routing and the analysis summary | `src/system.ts`, using `createGrant` and `analyzeInvocations` |
| Per-agent tool session, preflight admission, gateway, per-task `narrowGrant` | `src/workflow.ts` |
| The agent loop (Responses protocol, tool calls over HTTP) | `worker/agent.mjs` |
| The live model (the runtime's OpenAI adapter), its limits and usage | `src/model.ts` |
| The demo: broad and restricted setups and the outcome checks | `src/demo.ts` |
| Test doubles: scripted planner and coder, OpenAI interceptor | `test/scripted-model.ts` |

The planner is activated by a `subagent-handoff.task.submitted` event. Its
`handoff-to-coder` tool declares the effect `handoff.task.created` with the `project`
field copied from its input. The coder declares an invoker for that event and project.
`analyzeInvocations` matches the two and reports the coder's grants as indirectly
reachable from the planner. The supervisor uses the same declaration to decide which
agent a handoff activates.

## Boundaries and limitations

| Example owns | Runtime owns |
| --- | --- |
| Workspace tools, prompts, agent loop, routing, sample project, CLI, configuration | Exact tool grants and narrowing, gateway enforcement, preflight admission, invocation analysis, model mediation |

- **The analysis is advisory.** It reports potential paths from user declarations
  (`basis: user-declared`, `exhaustive: false`). It never blocks a run or changes a
  grant. Restriction is what limits authority.
- **The gateway is the only enforced boundary.** Agents are ordinary local Node
  processes, not sandboxed: no filesystem or network isolation. The model can act only
  through granted tools, but anything else running as your user is outside this
  example's control. Use the runtime's isolated execution targets for that; see the
  Cloud Logging example.
- **Grants are exact files.** The coder can replace existing files only; it cannot
  create, delete or rename files. Projects with more than 2048 files need a smaller
  project root.
- **Running a test script runs project code.** Keep `package.json`, test files and tool
  configuration out of `coderWritablePaths` unless you intend the coder to change what
  runs. The analysis notes common cases (test folders, Node, Jest and Vitest test file
  names, package manifests and lockfiles, `tsconfig*.json`, `*.config.js`/`.ts`,
  `Makefile`, `Dockerfile`); it cannot know every file your test script loads.
- **No provider escalation inspector exists for local tools.** Preflight reports
  partial coverage and the example treats it as advisory; grants stay mandatory.
- **Live model behavior varies** by model and run. The demo checks outcomes, and the
  records below say what live runs did. The scripted model in `test/` follows a fixed
  script for the bundled sample only.
- **A failed OpenAI request ends the run.** Neither the gateway nor the agents retry, so
  a transient provider error stops the demo with
  `Model gateway refused a request: Model provider request failed`.
- The local workspace tools need no secret. The runtime requires a credential handle per
  tool call, so the supervisor issues a random per-run handle that never reaches an agent.

Verified on November 2, 2026: `npm run check`, `npm run demo` (then a scripted run
with no key), analysis mode and `npm run test:package` on macOS with Node 22. Live
runs on the bundled sample with `gpt-5.6-terra` (macOS, Node 22.22), restricted and
then `--broad`: in both, the planner ran the failing test, read the project and
handed off `src/cart.js`; the coder, narrowed to that file, multiplied each price by its
quantity, and the test script went from exit 1 to exit 0. The restricted configuration
limited what the coder could ever receive to 2 files instead of 4 without changing the
outcome.

Newcomer path on November 3, 2026 (macOS): this folder was
copied out of the repository into its own Git repo, then `npm ci`, `npm run check`
(9 tests), `npm run demo` (then scripted), `cp config.example.json config.json` and
`npm start -- --config config.json` with the example config's `gpt-5.6-terra`. The
planner handed off `src/cart.js`, the coder's only change was multiplying by quantity,
and the test script went from exit 1 to exit 0.

November 4, 2026 (macOS, Node 22.22, no OpenAI key on the host), after `npm run demo`
moved to the live model: `npm run check` (13 tests), `npm run test:demo` (4 tests) and
`npm run test:package` passed, and `npm run demo` without a key printed the one-line
`OPENAI_API_KEY` message and exited 1.

Live run on November 4, 2026, from a throwaway workflow on a self-hosted macOS runner
with `gpt-5.6-terra`: `npm run demo` passed all three checks. In both setups the
planner handed off `src/cart.js`, the coder multiplied each price by its quantity, and
the test script went from exit 1 to exit 0; the restricted coder's 3 writes outside its
grant were refused with HTTP 403. OpenAI reported 24 requests, 26,984 input tokens and
1,126 output tokens, at most $0.07 at the configured rates.
