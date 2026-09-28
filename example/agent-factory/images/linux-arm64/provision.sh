#!/usr/bin/env bash
# Run as root inside a disposable builder guest. No authentication material is accepted.
set -euo pipefail
NODE_VERSION="$1"
NODE_SHA256="$2"
CODEX_VERSION="$3"
RUNNER_VERSION="$4"
RUNNER_SHA256="$5"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git openssh-client jq python3 python3-venv build-essential xz-utils libicu-dev
build_tmp="$(mktemp -d)"
trap 'rm -rf "$build_tmp"' EXIT
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" -o "$build_tmp/node.tar.xz"
printf '%s  %s\n' "$NODE_SHA256" "$build_tmp/node.tar.xz" | sha256sum --check --status
tar -xJf "$build_tmp/node.tar.xz" --strip-components=1 -C /usr/local
if test "$CODEX_VERSION" != none; then npm install --global "@openai/codex@${CODEX_VERSION}" --no-audit --no-fund; fi
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
install -d -o agent -g agent /opt/actions-runner /opt/factory /workspace /results
curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" -o "$build_tmp/runner.tar.gz"
printf '%s  %s\n' "$RUNNER_SHA256" "$build_tmp/runner.tar.gz" | sha256sum --check --status
tar -xzf "$build_tmp/runner.tar.gz" -C /opt/actions-runner
chown -R agent:agent /opt/actions-runner
/opt/actions-runner/bin/installdependencies.sh
# Runtime injects credentials per job. The guest agent provides a host-to-guest
# transport, so neither a shared SSH key nor a default password is needed.
passwd -l admin
passwd -l agent
systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
rm -f /etc/ssh/ssh_host_* /home/admin/.ssh/authorized_keys
rm -rf /home/admin/.codex /home/agent/.codex /root/.codex
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm/_cacache
node --version
if test "$CODEX_VERSION" != none; then codex --version; fi
/opt/actions-runner/bin/Runner.Listener --version

# Version inspection can create root-owned runner diagnostics; runtime runs as agent.
chown -R agent:agent /opt/actions-runner


# Runtime blocks guest-to-host gateway traffic, including the DHCP DNS proxy.
# Use public resolvers directly; a regular resolv.conf is not rewritten by resolved.
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:3 attempts:2\n' > /etc/resolv.conf
chmod 644 /etc/resolv.conf
