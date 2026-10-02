# Reference Software Factory worker image. The runtime configuration pins the pushed
# digest; rebuild and re-pin when changing the Codex version.
#   docker buildx build --platform linux/amd64 --build-arg CODEX_VERSION=0.159.2 \
#     -t ghcr.io/OWNER/software-factory-worker:codex-0.159.2 --push .
# Label org.opencontainers.image.source only with a public repository: the label is
# readable by anyone who can pull the image, so a public image would publish a
# private repository's name.
# Requirements checked at launch: /bin/sleep, Node.js, Git, `codex --version` equal
# to harness.version, and a usable UID/GID 10001 with a read-only root filesystem.
# The tools below are the baseline an agent needs on any repository: Codex searches
# with rg first, and agents script edits and builds with python3, jq and make.
# Language toolchains beyond Node and Python belong in per-repository images.
# Build leftovers (npm cache, Codex state written by the version check, /tmp) are
# removed in the same layer, and the build fails if any remain.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
      ripgrep fd-find jq curl patch diffutils procps file unzip xz-utils \
      python3 python3-venv build-essential \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /workspace/user agent \
 && for tool in rg fd jq curl patch diff ps file unzip xz python3 make gcc; do command -v "$tool" >/dev/null || exit 1; done \
 && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
 && rm -rf /root/.npm /root/.codex /root/.config \
 && find /tmp -mindepth 1 -delete \
 && test ! -e /root/.npm && test ! -e /root/.codex && test ! -e /root/.config && test -z "$(ls -A /tmp)"
USER 10001:10001
