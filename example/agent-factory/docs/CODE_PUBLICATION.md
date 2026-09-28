# Candidate publication

The coding VM receives a trusted bundle at an exact base commit. It creates and seals one candidate commit, then returns a bundle and metadata. The host retains and hash checks those bytes before publication.

The host issues a GitHub App installation token narrowed to the target repository and `Contents: write`. It checks the candidate's parent and tree, then pushes that exact commit to `refs/heads/factory/<sha256(execution ID, attempt ID)>`. An existing ref with another commit is a conflict. After an uncertain push response, the host reads the ref to distinguish a completed push from a failed one. The token is revoked when the operation finishes; its metadata remains in the private access ledger.

Independent acceptance uses a separate credential free VM and checks the retained candidate against the pinned base and configured tests. A branch may exist when acceptance fails. The factory does not create or merge a PR.

The default coding agent has no GitHub token. Tasks that need GitHub API access request explicit `githubPermissions` in `agents.yaml`; the issued token is limited to that agent's repository and attempt. The App private key never enters a VM.
