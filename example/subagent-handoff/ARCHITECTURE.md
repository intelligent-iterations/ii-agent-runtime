# Subagent handoff consumer mandate

1. **Capability:** a read-only planner hands a fix to a coder through a declared
   invocation path. The runtime warns about the coder authority the planner can reach,
   and exact grants bound what the coder can actually do.
2. **Intent:** prove a useful planner-to-coder loop can consume the runtime's tools,
   gateway and invocation analysis without teaching the runtime about agents, plans,
   tests or handoffs.
3. **Invariants:** enforcement in the gateway, not the agent; no model key in agent
   processes; exact grants that only narrow per task; analysis and routing read the
   same declaration; unknown preflight coverage stays visible; no parent-source imports;
   no test double in product code (`src/`).
4. **Minimum scope:** five local workspace tools, two agents, one handoff event, a
   bundled failing sample, a demo (`runDemo`) that runs both agents on the runtime's
   OpenAI adapter, a scripted model in `test/` that answers the adapter's intercepted
   OpenAI calls, and a copied-package test.
5. **Non-goals:** a general agent framework, sandboxing local processes, multi-step
   orchestration, reviewers, retries, git integration or new runtime APIs.
6. **Seams:** `defineTool`, `createGrant`, `narrowGrant`, `createToolSession`,
   `preflightTools`/`admitToolSession`, `openWorkerGateway`, `analyzeInvocations`
   and `executionServices.codexModelGateway`, all from installed package exports. The
   adapter's `fetch` option is where tests intercept OpenAI; the CLI never sets it.
7. **Implementation freedom:** prompts, tool shapes, routing and CLI output are example
   choices. They cannot widen a runtime grant.
8. **Evidence:** `npm run demo` runs the real model and checks outcomes (test script
   exit 1 then 0, gateway denials outside the grant, smaller reach when restricted),
   not text. Tests run the real gateway, grants, analysis, child-process agents, npm
   test execution and the same `runDemo` call, with only OpenAI's two HTTP endpoints
   answered by the scripted model. Only a run with a real key shows actual model
   behavior; the README records the live runs.
9. **Learnings:** no runtime change was required. The runtime requires a credential
   handle per tool call even for local tools, so the example issues a random per-run
   handle. The invocation analysis is advisory by design; restriction comes from grants.
   The adapter's existing `fetch` option was enough to keep the model double out of
   product code. The adapter does not retry, so a transient OpenAI error ends a run.
