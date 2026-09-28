# Dedicated factory images

`./setup.sh` builds and caches the worker profile automatically. Its local image
store starts for setup/launch and stops afterward; no external registry is needed.
The commands below are for maintainers who want to publish an image elsewhere.

This recipe builds a fresh Debian ARM64 Tart image from the digest in
`versions.json`. The default worker profile installs pinned Node, Codex and Actions runner versions.
Node and runner archives are verified against SHA-256 values. OS package versions
are retained inside `/opt/factory/os-packages.txt`; rebuilding later is not claimed
to produce identical bytes.

Run `./images/linux-arm64/build.sh NEW_STATE_DIRECTORY REGISTRY/IMAGE:TAG` with
Tart installed and your own registry available. The build uses a credential-free
NAT guest. Deploy only the resulting immutable OCI digest through runtime's
Softnet VM path. A successful image build does not prove runtime isolation.

The seal step checks that Codex auth, runner registration and host shares are
absent; locks login passwords; and leaves SSH disabled. Runtime's guest-agent
transport injects each runner's JIT configuration at execution time. GitHub delivers
explicit job secrets inside the VM. No private key or login session belongs here.

The factory worker runs as `agent`. The image recipe owns software installation;
runtime owns the generic deployment operations. The automatic recipe build has passed a
complete two-agent YAML launch with independent acceptance and cleanup; see
[verification](../../docs/VERIFICATION.md).

Runtime's host/gateway blocks require public DNS inside the image. The recipe
installs a regular `/etc/resolv.conf` using `1.1.1.1` and `8.8.8.8`; sealing checks
that exact configuration and resolves GitHub. It does not depend on the blocked
host DHCP DNS proxy. Use a newly built digest after this change: earlier images
with gateway DNS will fail public-name resolution under the stricter policy.
The live isolation probe must still verify public HTTPS and denied host/peer
connections; resolver configuration alone is not an isolation proof.

## SWE-bench evaluator profile

```sh
./images/linux-arm64/build.sh NEW_STATE_DIRECTORY REGISTRY/evaluator:TAG swe-bench
```

This profile starts from the same pinned Debian base in a fresh builder. It skips
Codex and installs Docker plus its CLI, AMD64 emulation, evaluator revision
`02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`, and the Python versions in
`swe-bench-requirements.lock`. The checkout and virtual environment use the paths
expected by `createSweBenchBenchmark`. Each deployed VM starts with no dataset,
candidate, evaluator result, registered runner, Docker image, or container.

The builder uses 4 GiB; the default worker builder retains its 2 GiB allocation.
Sealing checks evaluator imports/dependencies, the clean source revision, empty
Docker state and absence of credentials. Dependency versions and OS packages are
retained inside the image. Version pins do not promise byte-identical rebuilds;
deploy the immutable OCI digest produced by the build.
