# Independent deployment emulator proof

Use only provider-maintained or independent upstream emulators. Do not implement
or patch a cloud API server to make our adapters pass. The former repository-owned
emulators, their contract snapshots, runners and claimed passing evidence have
been removed. Their results do not satisfy cloud acceptance.

A deployment pass requires generated IaC, the actual pinned OpenTofu provider,
create/readback, saved-plan destruction, empty resource state and owned emulator
cleanup. Endpoint and synthetic credential overrides are permitted; rewriting
generated resources or substituting storage/function APIs is not. Missing coverage
is an unmet requirement, never a passing skip.

## Current implementation and results

These adapters currently provision VMs. The tests below validate that implemented
path. Existing-machine Docker execution is tested separately. An ECS/Fargate or
other managed-container emulator would require a corresponding runtime adapter;
it cannot validate the current VM adapter. No managed-container support is claimed.

| Provider | Independent emulator | Result and limits |
| --- | --- | --- |
| AWS | Moto 5.1.16 | EC2 creation, metadata policy readback, saved-plan destruction and cleanup pass; no guest execution/IAM proof |
| Azure | Floci Azure 0.15.0, digest pinned in `azure.py` | VM creation/readback, destruction and cleanup pass; image ID is opaque because upstream lacks the image API |
| GCP | Floci GCP 0.11.0, digest pinned in `gcp.py` | Compute creation, metadata/shielded settings readback, destruction and cleanup pass; synthetic image fixture |
| OCI | CloudEmu `a624a9526f7b55686218532b5282be99e176984f` | Instance/VNIC lifecycle and state/listener cleanup pass; no signature/IAM or guest proof |
| DigitalOcean | Gravel dotest v0.10.3 | Droplet lifecycle, bootstrap/monitoring assertions, token rejection and cleanup pass; VPC references not validated |
| Hetzner | hcloud-mock `89beaa1394bc360316f0272b0dcd55f3905cd669` | Instance lifecycle, output readback, saved-plan destroy, fixture and listener cleanup pass; bootstrap semantics and guest execution unverified |

All six supported VM providers have independent deployment lifecycle evidence.
Providers without a passing external-emulator path are excluded from configuration
and the adapter registry. No emulator run proves actual VM boot, cloud IAM or
network policy. Existing GitHub execution remains an explicit application-supplied
binding, separate from these cloud provisioning adapters.

## Reproduce

Build runtime with `npm ci` and `npm run build`. Use Node 22+, OpenTofu and the
Python/Go/Docker requirements below. `II_PROVIDER_VALIDATION_CACHE` may point to
an existing pinned `.terraform` installation and lockfile; container runners
install their Linux plugins independently. Use only disposable emulator instances.

- AWS: in an isolated Python environment install `moto[server]==5.1.16` and boto3.
  Start a fresh `moto_server -H 127.0.0.1 -p 14566`, run
  `python test/live/deployment/aws.py`, then stop the owned server. Never use a
  shared server: the script expects an empty instance set.
- Azure: build `modules/remote-host/Dockerfile` as `ii-runtime-executor:20261026`
  (or set `II_EMULATOR_RUNNER_IMAGE`), then run
  `python3 test/live/deployment/azure.py`. TLS trust is confined to its Linux runner.
- GCP: `python3 test/live/deployment/gcp.py` with Docker available.
- OCI: `go -C test/live/deployment/oci-emulator test -v -count=1 .` with Go 1.26+.
  The provider's IPv6 polling makes this take approximately four minutes.
- DigitalOcean: `go -C test/live/deployment/digitalocean-emulator test -v -count=1 .`
  with Go 1.26+.
- Hetzner: `python3.12 test/live/deployment/hetzner.py`. The harness checks out the
  exact upstream revision, installs it in an isolated venv, and owns its database,
  synthetic key/firewall, process and listener. Python 3.12+, Git and ssh-keygen
  are required. Upstream code is not modified; dependency versions are recorded.
The scripts retain operation logs and fail on unsuccessful deployment checks.
No custom cloud server fallback exists. Ordinary unit tests do not replace these
external-emulator deployment checks.

## Sources and evidence

- [Moto EC2 coverage](https://docs.getmoto.org/en/stable/docs/services/ec2.html)
- [Floci GCP](https://github.com/floci-io/floci-gcp/tree/0.11.0)
- [Floci Azure](https://github.com/floci-io/floci-az/tree/0.15.0)
- [CloudEmu](https://github.com/stackshy/cloudemu/tree/a624a9526f7b55686218532b5282be99e176984f)
- [Gravel](https://github.com/gravel-project/gravel/tree/v0.10.3/cloud/digitalocean/dotest)
- [hcloud-mock](https://github.com/koval01/hcloud-mock/tree/89beaa1394bc360316f0272b0dcd55f3905cd669)

The verification index and logs are under `docs/evidence/multicloud/` in this
internal repository. Hetzner uses the upstream emulator by default.
