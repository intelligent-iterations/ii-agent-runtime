# Trusted Linux host for the Codex run on macOS or Windows (Docker Desktop or Colima).
# It runs the compiled supervisor with the host's Docker daemon, OpenTofu and iptables.
# Used by `npm run start:linux`; see README "Run from macOS".
FROM docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5 AS docker
FROM ghcr.io/opentofu/opentofu:1.12.6-minimal@sha256:2fedbb3e956b083582543dabb76eba17e9f961dfd055311ea054a6191cfae9dd AS tofu
FROM node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
RUN apt-get update && apt-get install -y --no-install-recommends iptables sudo && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
