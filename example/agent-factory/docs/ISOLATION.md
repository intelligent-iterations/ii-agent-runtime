# Live network isolation probe

Run the credential-free probe against a pinned factory image:

```sh
node --import tsx scripts/verify-isolation.ts IMAGE_AT_DIGEST NEW_EVIDENCE_DIRECTORY
```

The script creates two fresh 2 GiB Tart VMs through the runtime, using the example’s explicit
Softnet policy. It does not inject secrets or register Actions runners.
It creates only owned TCP listeners and probes:

- Each guest's own listener through its interface address: must succeed.
- The host listener through each selected host IPv4 interface: must succeed from the host.
- The sibling guest's listening port, in both directions: must not connect.
- The host listener through host IPv4 addresses and the guest gateway: must not connect from either guest.
- Public HTTPS to GitHub: must return 200 from both guests.

Each guest must have a distinct MAC address and IPv4 address. Each also listens
on a different port, so a peer probe cannot accidentally reach its own listener. A failed positive control invalidates the proof. No networking
restriction is relaxed to make the probe pass.

`probe-*.json` records the connection results. `proof.json` is written only after
all assertions pass. `cleanup.json` records independent absence checks after
runtime destruction; cleanup runs on failure as well. Preserve diagnostics if
cleanup fails and reconcile the recorded manifests before another attempt.

This evidence covers IPv4 TCP at the tested endpoints and ports. It does not
establish exhaustive IPv6/UDP isolation, deny access to every public host address,
prove containment of a VM escape, or verify GitHub job permissions. Concurrent
real agents and controller-death cleanup remain separate tests.

The configuration follows [Tart's Softnet isolation documentation](https://tart.run/faq/#connecting-to-a-service-running-on-host)
and the [Softnet implementation](https://github.com/openai/softnet).

Repeat the probe after network or image changes.
