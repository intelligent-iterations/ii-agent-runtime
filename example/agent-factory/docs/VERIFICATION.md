# Verify an installation

Run local checks from `example/agent-factory`:

```sh
npm run check
```

The local suite covers manifest policy, narrow App token issuance, grant-ledger history, Tart and libvirt execution, scheduling, sealed candidates and recovery. It does not establish live GitHub or VM behavior.

For a live proof, use a separate clean clone and private configuration outside the source checkout. Install the App on the private factory repository and controlled targets A and B. Keep target C uninstalled. Run one agent for A and one for B. From the exact token context each agent receives, attempt pushes and PR creation on the other installed repository and C. The test passes only when the requests reach GitHub, GitHub denies them, and no ref or PR appears. Also check the permitted operation, published commit, independent acceptance, token expiry or revocation, grant history, and removal of owned VMs and runners. Redact credential values from evidence.

After a dedicated batch, audit it with:

```sh
node scripts/verify-onboarding.mjs INSTALLATION_DIRECTORY EXPECTED_ACCEPTED_COUNT
```

The audit uses the configured App to read branch and workflow metadata and checks cleanup through the selected VM provider. Run the [network probe](ISOLATION.md) after image or network changes. On Linux x64, run `npm run verify:linux -- VOLUME@sha256:DIGEST` on the KVM host. It starts two VMs, checks public HTTPS and own, host, and sibling TCP/UDP reachability, then requires both owned VMs to be removed. Also run `npm run verify:linux-crash` to exercise interrupted cleanup. A real two-agent GitHub Actions batch and the cross-repository denial probes are needed before declaring the combined Linux and App path live verified. [SWE-bench verification](SWE_BENCH.md#verification) is separate from code acceptance.
