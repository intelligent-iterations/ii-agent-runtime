# Permission preflight against upstream emulators

These tests run the real collectors against pinned, unmodified upstream emulator
processes. They seed disposable resources through provider APIs, check readback,
run preflight, exercise negative controls, and remove the resources and owned
emulator processes. Synthetic credentials are used throughout. Production
collectors are unchanged: only test transport destinations are overridden.

| Provider | Emulator | Observed result |
| --- | --- | --- |
| GCP | Floci GCP 0.11.0, digest pinned in runner | Attached service account collected; Policy Troubleshooter is unsupported by the emulator and missing authority blocks admission; real HTTP gateway allows granted read and denies ungranted read before credential resolution; deleted-resource negative control and cleanup pass |
| AWS | Moto 5.1.16, official AWS CLI 2.31.30 container pinned by digest | Lambda execution role and inline role policy collected; principal-policy simulation unsupported by Moto, so admission remains blocked; missing-function negative control and cleanup pass |
| AWS workflow role | Moto 5.1.16, official AWS CLI 2.31.30 extracted from AWS's signed macOS package (no Docker) | GitHub OIDC provider, deploy role, inline and attached policies seeded through IAM; production `awsWorkflowRoleAssessor` joins a recorded deploy workflow to the role; trust admits `main` and excludes another branch; missing-role negative control; inert write is clear with no AWS reads; simulation unsupported, so authority stays declared; cleanup passes |
| GCP workflow service account | Floci GCP 0.11.0, digest pinned in runner | Service account, its `roles/iam.workloadIdentityUser` binding for one repository, and project role bindings seeded through IAM and Resource Manager v1; production `gcpWorkflowServiceAccountAssessor` joins a recorded deploy workflow to the account; trust admits the bound repository and excludes another; bound roles read; Policy Troubleshooter unsupported (HTTP 406), so authority stays declared; missing-account negative control (HTTP 403, unknown); inert write is clear with no GCP reads; cleanup passes |
| Azure | Floci Azure 0.15.0, digest pinned in runner | **Unsupported**: VM creation accepts `SystemAssigned` identity but VM readback omits identity. Collector does not invent it; unknown blocks admission; missing-resource control and cleanup pass. Runner exits 2, not success |
| GitHub | No GitHub emulator used | Fixture tests plus recorded live read-only metadata probe. GitHub Actions execution/token semantics remain unverified |

## Reproduce

Requires the repository's installed Node dependencies and Docker Desktop (the
recorded November 2 runs used Colima with Docker Engine 29.2.1, which provides the
same route). AWS uses Docker Desktop's `host.docker.internal` route to the owned loopback Moto
server. This runner does not claim Linux Docker compatibility.

```sh
node --import tsx test/live/gcp-preflight-emulator.ts

python3 -m venv /tmp/ii-permission-emulators
/tmp/ii-permission-emulators/bin/pip install 'moto[server]==5.1.16' 'boto3==1.40.30'
/tmp/ii-permission-emulators/bin/python test/live/cloud-collector-emulator.py aws

python3 test/live/cloud-collector-emulator.py azure

# Workflow service account join (GitHub -> GCP).
node --import tsx test/live/gcp-workflow-identity-emulator.ts

# Workflow role join. Needs the official AWS CLI v2 binary, not Docker.
/tmp/ii-permission-emulators/bin/python -I test/live/workflow-role-emulator.py /absolute/path/to/aws-cli/aws
```

GCP and Azure images are pulled by digest on first use. AWS also pulls the pinned
official CLI image. Capture stdout as the result record. A nonzero exit indicates
failed or unsupported coverage, never a passing skip. The runners create their
own disposable emulator instances and do not reuse a shared instance.

These are collector/API-integration and local gateway results. They **do not
prove real cloud IAM, OIDC trust, privilege escalation, guest execution, or network
isolation**. No Lambda code, startup script or Azure VM command is executed.
Emulators cannot replace the live-provider evidence required for those claims.
This is separate from the compute deployment acceptance tests in
[deployment/EMULATORS.md](deployment/EMULATORS.md).

Recorded results are kept with the internal evidence records, which are not part of
the public tree.
