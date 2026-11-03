# Cloud Logging consumer mandate

1. **Capability:** retrieve one Cloud Function's or Cloud Run service's recent
   errors through a scoped runtime gateway, and deny other projects, resources
   and mutations.
2. **Intent:** prove a useful independent application can consume the existing
   runtime without teaching runtime its workload semantics.
3. **Invariants:** enforcement outside the agent; no Google/model credential in
   the worker; exact grants; explicit placement; unknown preflight coverage stays
   unknown; no parent-source imports; every claim backed by executable evidence.
4. **Minimum scope:** one custom read operation (`entries.list`) with an
   adapter-built query, one project and resource, bounded summaries, a standard
   Codex CLI with an MCP transport, Application Default Credentials instructions,
   runnable copied package, deterministic and upstream-emulator tests.
5. **Non-goals:** deployment automation, a general Google Cloud connector, custom
   UI, workflow engine, automatic remediation, custom cloud emulator, or proof of
   exhaustive IAM safety.
6. **Seams:** exported ToolOperation and ToolGrant for the trusted adapter;
   execution target and gateway exports for isolation; MCP only for agent
   ergonomics.
7. **Implementation freedom:** grouping, query bounds, example CLI and credential
   sourcing are consumer choices. They cannot widen a runtime grant.
8. **Evidence:** unit/gateway fixtures establish request semantics; floci-gcp
   establishes Logging API request and response compatibility (it does not apply
   every filter clause, so the adapter re-checks scope locally); isolated Linux
   probes establish tested network behavior. Only own-credential live runs
   establish Google IAM and live data behavior.
9. **Learnings:** the example uses only existing runtime seams (exact grants,
   credential resolution, the HTTP gateway, model mediation and the Docker/OpenTofu
   target). No runtime architectural change was required for this consumer.
