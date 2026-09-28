# Agent factory example

Run coding agents from `agents.yaml` in fresh VMs on an Apple Silicon Mac with Tart or a Debian/Ubuntu Linux x64 host with KVM and libvirt. A single GitHub App handles approved factory and source repositories. The trusted host publishes each sealed candidate branch; a separate VM verifies the result.

## Set up

1. Create a private factory repository. Install your GitHub App on that repository and on each source repository agents may use. Give the App only the permissions needed for workflows, Actions runners, Actions secrets, repository contents, and any optional agent API operations. An administrator must approve each installation or repository addition.
2. Add your OpenAI API key as a repository Actions secret named `CODEX_CODE_API_KEY` in the factory repository. Keep the App private key on the host: preferably in Keychain on macOS, or in a private file on Linux.
3. Save a private App configuration outside the source checkout. Example:

```json
{
  "appId": 123456,
  "key": { "kind": "keychain", "service": "ii-factory-app", "account": "factory" },
  "revision": "2026-09-28-approved",
  "approvedBy": "YOUR_GITHUB_LOGIN",
  "repositories": {
    "your-org/agent-factory": { "id": 111, "permissions": { "actions": "write", "administration": "write", "secrets": "read", "contents": "write", "workflows": "write", "metadata": "read" } },
    "your-org/project": { "id": 222, "permissions": { "contents": "write", "issues": "read", "pull_requests": "write" } }
  }
}
```

Use a `0600` file in a private `0700` directory. The `id` is GitHub's numeric repository ID. The key reference identifies the App's private signing key; no token values belong in this file. On Linux, use `"key": { "kind": "file", "path": "/private/path/app-key.pem" }`; the key file must be a regular `0600` file owned by the factory user. To import a key into macOS Keychain, use `security add-generic-password -s ii-factory-app -a factory -w "$(cat /private/path/app-key.pem)" -U`, then securely remove the temporary key file.

Keep the App webhook active. The factory reads its own installation deliveries through an App JWT before minting a token and records the GitHub actor. You can inspect this before setup:

```sh
npm ci && npm run build
node dist/cli.js access sync .factory /private/path/factory-app.json
node dist/cli.js access installations .factory
```

If you run a webhook receiver, you can also feed the exact payload and its signed headers directly:

```sh
node dist/cli.js access webhook .factory installation_repositories DELIVERY_ID SIGNATURE delivery.json webhook-secret.txt
```

If a delivery was missed, an administrator can inspect the GitHub audit event and record its event ID, actor, installation ID and time with `node dist/cli.js access review .factory OWNER/REPO INSTALLATION_ID granted ACTOR 2026-09-28T10:00:00.000Z AUDIT_EVENT_ID`. A removal uses `removed`. Without installation evidence, the factory blocks token issuance. GitHub's live installation ID and each minted token's repository and permissions are checked again for every operation. The CLI shows stale or uncertain grant observations as risks; it cannot promise visibility during an outage.

```sh
git clone https://github.com/intelligent-iterations/ii-agent-runtime.git
cd ii-agent-runtime/example/agent-factory
export II_FACTORY_APP_CONFIG=/private/path/factory-app.json
./setup.sh
```

Setup installs host prerequisites, checks the existing repository and secret through an App token, and builds the local worker image. On Linux it prepares the KVM/libvirt pool and network and uses a local x64 image. It does not create a GitHub App or install it for you. See [verification](docs/VERIFICATION.md) for host prerequisites.

## Add agents

Edit `.factory/agents.yaml`:

```yaml
schemaVersion: 1
defaults: { codexSecret: CODEX_CODE_API_KEY }
agents:
  - name: fix-login
    repository: your-org/project
    prompt: Fix login validation and add tests.
  - name: issue-triage
    repository: your-org/project
    prompt: Review issue 42 and update it if needed.
    githubPermissions: { issues: write }
```

The normal coding agent receives no GitHub credential. `githubPermissions` requests one short lived token for that agent attempt, restricted to its repository and listed permissions. The factory refuses requests outside the local App policy. Each token grant is recorded without its value. The App private key and factory repository tokens remain on the host.

```sh
npm run launch
node dist/cli.js access list .factory
node dist/cli.js access history .factory GRANT_ID
```

The worker seals a candidate bundle. The host checks its hash and exact parent commit, then publishes a deterministic `factory/` branch using an App token. Independent verification runs in a credential free VM. A branch is not an acceptance result; inspect the reported `accepted` field. The factory does not open or merge a PR.

## Recovery and upgrades

Rerun `npm run launch` to reconcile interrupted work with its pinned configuration. Recheck an installation with `./setup.sh`. Finish or recover old deploy key attempts using their original checkout before switching installations. Remove old deploy keys, owned Actions secrets, and local private keys after those attempts finish. Create a new installation directory for an image or policy change that cannot safely be applied to an in flight batch.

[Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md)
