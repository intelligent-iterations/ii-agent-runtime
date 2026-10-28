# Configurable agent hosting

The runtime deploys and runs an agent in the explicitly configured environment.
Container isolation is selected by `environment.provider` (`docker` or `openshell`)
and hosting by the required `environment.hosting` configuration.
Missing hosting fails validation before execution.

GitHub hosting requires an explicit `executionTarget` bound to the selected
execution environment. Runtime does not infer placement from the calling process
or dispatch a GitHub job when `provider: github` is selected.

For VM providers, runtime IaC provisions the configured host, creates the worker,
and destroys that host after the run. A supplied execution target cannot override
a configured VM deployment. Deployment scratch paths and cloud credentials do not
select the agent's execution location.

## Infrastructure components

- `src/deployment` and `src/providers/deployment`: compute-host IaC, saved plans,
  validation, provisioning, destruction, and provider-specific bootstrap.
- `src/providers/execution/remote`: worker operations over authenticated SSH.
  `stdio.ts` starts the selected isolation adapter, reads infrastructure commands
  from standard input, writes replies to standard output, and closes the session's
  resources. Operations cover provisioning, bounded command execution, setup,
  isolation, gateway forwarding, and cleanup.
- `src/pipeline`: execution contracts, target selection, and worker setup.

## Hosting configuration

For an Ubuntu VM provider:

```json
{
  "provider": "aws",
  "executorImage": "registry.example/runtime-tools@sha256:REPLACE_WITH_DIGEST",
  "infrastructure": {
    "ami": "ami-YOUR_IMAGE",
    "instance_type": "t3.medium",
    "subnet_id": "subnet-YOUR_SUBNET",
    "vpc_security_group_ids": ["sg-YOUR_FIREWALL"],
    "key_name": "YOUR_OPERATOR_KEY"
  },
  "providerConfiguration": { "region": "us-east-1" },
  "ssh": {
    "user": "ubuntu",
    "identityFile": "/private/operator-key",
    "knownHostsFile": "/private/known_hosts"
  }
}
```

Place this object under `environment.hosting` in the runtime configuration.
Agent image, harness, and permissions are configured independently.
Provider credentials are trusted host inputs, outside canonical configuration.
Network reachability, SSH authentication and a trusted host-key/host-CA enrollment
must already be configured for the chosen cloud. Both Docker and OpenShell use
the same SSH execution transport. For OpenShell, the executor starts a private
session gateway with mutual TLS, disables policy proposals, and shuts it down
after worker cleanup. OpenShell 0.1.2 binaries are checksum-pinned for AMD64 and
ARM64. SSH never accepts unknown host keys automatically. Provider-specific compute inputs are defined in
`src/providers/deployment/virtual-machines.ts`.

## Infrastructure image

Build `modules/remote-host/Dockerfile` from the repository root and publish it to
your registry for the target host architecture (for example, `linux/amd64`).
It supplies Node, OpenTofu, Docker tools and the authenticated worker command
protocol. The application agent image is a separate OCI artifact.

On VM hosts the executor uses the Docker socket, host networking and NET_ADMIN.
The agent uses the existing Docker or OpenShell isolation implementation with
its resource and network policy.
The model and code-host credentials stay in the initiating process's gateway.

## Records and cleanup

Canonical runtime configuration binds hosting, agent configuration and permissions.
The run report records the requested host, isolation provider, image and permissions.
Each provisioned host also retains private deployment metadata, saved plans and
cleanup receipts under the initiating host's work directory. Credentials must not
be placed in infrastructure settings or provider configuration. These records can
contain infrastructure identifiers; retain them on the operator's approved storage.

Failed provisioning still attempts host destruction. A failed remote worker cleanup
is reported even when host deletion succeeds. There is no automatic job retry,
application reconciliation or implicit fallback to a different cloud.

## Verification status

AWS, Azure, GCP, OCI, DigitalOcean and Hetzner have VM mappings, external-emulator
deployment proof and the common remote execution path. Vercel, Railway, and Fly execution adapters are outside this PR's
scope and are not accepted by runtime configuration.

- Actual OpenTofu schemas validate the six VM resource mappings.
- Moto tests AWS EC2 API apply, metadata readback, destroy and empty final state.
  Moto does not boot the VM or verify AWS IAM/network behavior.
- A real local Linux host tests pinned SSH, real worker creation, streamed gateway
  traffic, network isolation, credential separation and cleanup with both Docker
  and OpenShell. Use `II_TEST_ISOLATION=openshell` with
  `test/live/deployment/remote-host.ts` to select the OpenShell conformance run.
- Live cloud account acceptance remains separate from these local checks.

## Remaining compatibility work

- Cloudflare Containers can run Docker, but prohibit iptables manipulation; the
  existing Docker isolation implementation depends on iptables. Equivalent
  provider-enforced network isolation needs implementation and verification.
  Cloudflare explicitly says Docker-in-Docker cannot run under `wrangler dev`.
  [Cloudflare Docker-in-Docker documentation](https://developers.cloudflare.com/sandbox/sdk/guides/docker-in-docker/)
- Render offers an early-access sandbox API. Its execution and isolation behavior
  still needs an adapter and conformance evidence; a Render service deployment is
  not being substituted for that work.
  [Render Sandboxes](https://render.com/docs/sandboxes)
- Fastly Compute executes WebAssembly packages. The current Linux OCI agent is not
  a compatible package. No forwarding service is counted as hosting the agent.
  [Fastly Compute](https://quic.fastly.com/documentation/guides/compute/getting-started-with-compute/)

These entries are unresolved work, not supported-provider claims. Storage and
queue emulators do not verify compute hosting, SSH trust, or worker isolation.
