# Safe subagent handoff

A read-only **planner** agent investigates a failing test and hands a precise fix to a
**coder** agent, which edits the code and runs the test. Before anything runs,
II Agent Runtime analyzes the declared agents and warns that the planner can
indirectly reach the coder's write access through the handoff. Narrowing the coder's
grants shrinks that reachable authority without breaking the handoff.

- Both agents are small local TypeScript processes. They see only a gateway endpoint
  and token; every model request and tool call goes through the runtime gateway.
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
npm run demo
```

Requirements: Node 22.16+, Git and npm. The demo and tests need no model key.

## See it work

`npm run demo` runs both agents on temporary copies of the bundled `sample/` project
(a cart whose total ignores item quantity), once with a broad coder and once with a
restricted one. The agents are driven by a deterministic scripted model, so the run is
reproducible; the gateway, grants, analysis, routing and test execution are real.
Abridged output:

```text
== Broad setup: the coder may write every project file ==
  ! Based on declarations, planner can potentially activate coder via handoff-to-coder; write-file is indirectly reachable (declared).
  Planner's own write grants: 0
  Reachable through the coder: write-file on 4 file(s) [package.json, src/cart.js, src/currency.js, test/cart.test.js]; run-script [test]
  Note: includes build/CI control files: with run-script, the coder could change what the test command executes
  Note: includes test files: the coder could weaken a test instead of fixing the code

== Restricted setup: the coder may write only src/ files ==
  ! Based on declarations, planner can potentially activate coder via handoff-to-coder; write-file is indirectly reachable (declared).
  Reachable through the coder: write-file on 2 file(s) [src/cart.js, src/currency.js]; run-script [test]
Planner (read-only):
    run-script test → HTTP 200, exit 1
    read-file test/cart.test.js → HTTP 200
    read-file src/cart.js → HTTP 200
    handoff-to-coder src/cart.js → HTTP 200
Handoff: handoff.task.created → coder; files [src/cart.js]
Coder (write-file narrowed to [src/cart.js] of 2 configured):
    read-file src/cart.js → HTTP 200
    write-file src/cart.js → HTTP 200
    run-script test → HTTP 200, exit 0
Gateway check with the coder's token:
    write-file test/cart.test.js → HTTP 403 (file unchanged)
    write-file package.json → HTTP 403 (file unchanged)
    write-file src/currency.js → HTTP 403 (file unchanged)
Test script: exit 1 before, exit 0 after.

Restricting the coder cut the files the planner can indirectly get written from 4 to 2. The handoff still fixed the test (exit 0).
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
  Each agent is limited to 16 model requests and a $1 reservation at your rates; this
  is not an independently verified billing cap. Every request reserves its worst case
  (its input plus up to 4,000 output tokens) and is never refunded, so use the model's
  real rates: inflated rates stop a run early with
  `Model gateway refused a request: Model cost limit reached`.

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
your project **in place**, so use a clean Git working tree and review the diff.

## Verify

```sh
npm run check          # TypeScript + tests: analysis, routing, real gateway denials, full scripted handoffs
npm run test:package   # packed runtime, copy outside the repo, install, check, build, CLI help and demo
```

## How it works

| Piece | Where |
| --- | --- |
| Tools (`list-files`, `read-file`, `write-file`, `run-script`, `handoff-to-coder`) | `src/workspace.ts`, defined with `defineTool` |
| Grants, invoker declarations, routing and the analysis summary | `src/system.ts`, using `createGrant` and `analyzeInvocations` |
| Per-agent tool session, preflight admission, gateway, per-task `narrowGrant` | `src/workflow.ts` |
| The agent loop (Responses protocol, tool calls over HTTP) | `worker/agent.mjs` |
| Scripted and live models | `src/model.ts` |

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
- **The scripted model is a test double** for the bundled sample only. Live model
  behavior varies by model and was exercised once on the bundled sample (below).
- The local workspace tools need no secret. The runtime requires a credential handle per
  tool call, so the supervisor issues a random per-run handle that never reaches an agent.

Verified on November 2, 2026: `npm run check`, `npm run demo`, analysis
mode and `npm run test:package` on macOS with Node 22. Live runs on the bundled sample
with `gpt-5.6-terra` (macOS, Node 22.22), restricted and then `--broad`: in both, the
planner ran the failing test, read the project and handed off `src/cart.js`; the coder,
narrowed to that file, multiplied each price by its quantity, and the test script went
from exit 1 to exit 0. The restricted configuration limited what the coder could ever
receive to 2 files instead of 4 without changing the outcome.

Newcomer path on November 3, 2026 (macOS): this folder was
copied out of the repository into its own Git repo, then `npm ci`, `npm run check`
(9 tests), `npm run demo`, `cp config.example.json config.json` and
`npm start -- --config config.json` with the example config's `gpt-5.6-terra`. The
planner handed off `src/cart.js`, the coder's only change was multiplying by quantity,
and the test script went from exit 1 to exit 0.
