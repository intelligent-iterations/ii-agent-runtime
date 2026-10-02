# Software Factory

File a GitHub issue, get a pull request. Software Factory gives an organization one
private **hub** repository. People open an **Agent task** issue there, name one of
the organization's repositories and describe the work. A Codex agent does it in an
isolated container and the hub replies with the pull request.

Built on [II Agent Runtime](../../README.md).

## Set up

You need Node.js 22.16+, the GitHub CLI, Docker, and owner access to the organization.

1. Build the worker image the agent runs in, push it to a registry the hub can read,
   and note its digest:

   ```sh
   docker buildx build --platform linux/amd64 --build-arg CODEX_VERSION=0.159.2 \
     -t ghcr.io/OWNER/software-factory-worker:codex-0.159.2 --push example/software-factory/worker-image
   ```

   If the image is private, give the hub repository Read access under the package's
   **Manage Actions access**. Don't add an `org.opencontainers.image.source` label
   that names a private repository.

2. Onboard:

   ```sh
   example/software-factory/onboard.sh --worker-image ghcr.io/OWNER/software-factory-worker@sha256:<digest>
   ```

   It creates the hub repository, a GitHub App and the hub's secrets, asks for an
   OpenAI API key, and asks you to approve the limits. Rerun it to resume or to
   change the limits.

## Use

Open an **Agent task** issue in the hub: the repository, an optional base branch,
and the task. The hub replies when the agent starts and again with the pull request.
Close and reopen the issue to retry.

## Limits and costs

- Only someone with write access to the named repository can start an agent
  (or, if you choose label approval, add the approval label).
- Defaults for the whole organization: 3 agents at once, 20 runs and $250 a month,
  $10 of model use and 15 minutes per run. Each run reserves its budget before it
  starts. Change them by rerunning onboarding or editing `.software-factory/policy.json`
  in the hub; set `limits.enabled` to `false` there to pause.
- Runs use GitHub-hosted runners (billed to your organization) and your OpenAI key.

## Security

- The App key and the OpenAI key stay in the hub's trusted job; the agent never gets them.
- The agent's network reaches only a gateway that adds credentials outside the
  container. Dependencies install first, with internet access and no keys.
- Each run gets short-lived tokens scoped to the one repository. The agent pushes a
  task branch and the hub opens the pull request; protect your default branch,
  because the agent's token can write to the repository.

Hubs created under the earlier name, Agent Factory, keep their `agent-factory`
repository, workflow, folder and secret names.

## Roadmap

- Install the pinned Codex CLI at run time on the official Node image, so no one has to build an image.
- Limit the setup step's network to package registries.
- Per-repository worker images (for example mobile or browser toolchains).
