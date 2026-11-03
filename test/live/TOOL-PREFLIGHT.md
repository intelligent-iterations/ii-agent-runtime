# Live preflight metadata checks

Run only against explicitly selected test resources. These probes make read-only
metadata requests. They never execute the assessed agent operations, mint an
agent credential, write a workflow, change IAM, or deploy a resource.

```sh
II_PREFLIGHT_LIVE=read-only-test-resources node --import tsx test/live/tool-preflight.ts gcp
```

Supply the inputs below through the trusted environment before running the
command. Replace `gcp` with `github`, `aws`, or `azure` as appropriate. Do not put
tokens in shell arguments, commit them, or use shell tracing.

| Provider | Required environment variables |
| --- | --- |
| GitHub | `II_PREFLIGHT_GITHUB_REPOSITORY`, `II_PREFLIGHT_GITHUB_BRANCH`, `II_PREFLIGHT_GITHUB_SCRIPT`, `II_PREFLIGHT_GITHUB_READ_TOKEN`, `II_PREFLIGHT_GITHUB_EXPECTED` (`finding`, `unknown`, or `clear`) |
| GCP | `II_PREFLIGHT_GCP_PROJECT`, `II_PREFLIGHT_GCP_ZONE`, `II_PREFLIGHT_GCP_INSTANCE`, `II_PREFLIGHT_GCP_READ_TOKEN`, `II_PREFLIGHT_EXPECTED_IDENTITY` (attached service-account email) |
| Azure | `II_PREFLIGHT_AZURE_VM_ID`, `II_PREFLIGHT_AZURE_READ_TOKEN`, `II_PREFLIGHT_EXPECTED_IDENTITY` (attached managed-identity principal ID) |
| AWS | `II_PREFLIGHT_AWS_FUNCTION_ARN`, `II_PREFLIGHT_AWS_CLI` (absolute executable path), `II_PREFLIGHT_AWS_ACCESS_KEY_ID`, `II_PREFLIGHT_AWS_SECRET_ACCESS_KEY`, optional `II_PREFLIGHT_AWS_SESSION_TOKEN`, `II_PREFLIGHT_EXPECTED_IDENTITY` (execution-role ARN) |

The expected identity is an independent test assertion about the selected test
resource, not an input to the security check. Use a reader credential with access
to that resource's metadata. The AWS CLI receives only explicitly supplied
credentials and fixed read arguments; ambient profiles and metadata discovery
are disabled. GCP and Azure collectors use fixed public-cloud API origins.

Each successful command prints one JSON record with the date, provider, read
result, and limitations. It omits keys, raw provider responses, resource names
and identity names. Missing inputs, failed reads, and mismatched expectations
exit nonzero. They are not passing skips. Keep the command, runtime/CLI versions,
source revision and output with the private validation record.

## What a pass proves

- The provider accepted the metadata read for the named test resource.
- The collector observed the independently expected attached identity (clouds),
  or collected the repository workflows and produced the expected assessment
  (GitHub).
- Preflight did not resolve an agent backing credential.
- Cloud checks remained unknown when effective authority and protections were
  unverified, rather than converting attached-identity evidence into an IAM proof.

A pass does **not** establish that a privilege-escalation path can execute. It does
not prove cloud role permissions, token scoping, branch/environment protections,
OIDC trust, or network isolation. Those need separate end-to-end provider tests
with independent positive/negative controls and cleanup evidence.

The GitHub metadata probe passed on 2026-10-29 against the existing internal
runtime repository using read access: three workflows read, unknown execution
assessment, no backing-key resolution. A nonexistent-branch negative control
failed as expected. The captured result is kept with the internal evidence records,
which are not part of the public tree.
AWS, GCP and Azure live probes have not yet run. No live escalation proof is claimed.
