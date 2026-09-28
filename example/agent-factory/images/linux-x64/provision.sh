#!/usr/bin/env bash
# Runs in a disposable image builder. No task or provider credential is accepted.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
NODE_VERSION="$1" NODE_SHA256="$2" CODEX_VERSION="$3" RUNNER_VERSION="$4" RUNNER_SHA256="$5"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git openssh-client jq python3 python3-venv build-essential xz-utils libicu-dev qemu-guest-agent sudo
build_tmp="$(mktemp -d)"
trap 'rm -rf "$build_tmp"' EXIT
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$build_tmp/node.tar.xz"
printf '%s  %s\n' "$NODE_SHA256" "$build_tmp/node.tar.xz" | sha256sum --check --status
tar -xJf "$build_tmp/node.tar.xz" --strip-components=1 -C /usr/local
npm install --global "@openai/codex@${CODEX_VERSION}" --no-audit --no-fund
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
install -d -o agent -g agent /opt/actions-runner /opt/factory /workspace /results
curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o "$build_tmp/runner.tar.gz"
printf '%s  %s\n' "$RUNNER_SHA256" "$build_tmp/runner.tar.gz" | sha256sum --check --status
tar -xzf "$build_tmp/runner.tar.gz" -C /opt/actions-runner
chown -R agent:agent /opt/actions-runner
/opt/actions-runner/bin/installdependencies.sh
passwd -l ubuntu 2>/dev/null || true
passwd -l agent
systemctl disable ssh.service ssh.socket 2>/dev/null || true
systemctl enable qemu-guest-agent.service
rm -f /etc/ssh/ssh_host_* /home/ubuntu/.ssh/authorized_keys
rm -rf /home/ubuntu/.codex /home/agent/.codex /root/.codex
install -d -m 0755 /etc/netplan
printf 'network:\n  version: 2\n  ethernets:\n    all:\n      match:\n        name: "en*"\n      dhcp4: true\n      dhcp4-overrides:\n        use-dns: false\n      nameservers:\n        addresses: [1.1.1.1, 8.8.8.8]\n      dhcp6: false\n      accept-ra: false\n' > /etc/netplan/99-factory.yaml
touch /etc/cloud/cloud-init.disabled
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:3 attempts:2\n' > /etc/resolv.conf
chmod 644 /etc/resolv.conf
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm/_cacache /var/lib/systemd/random-seed
truncate -s 0 /etc/machine-id
node --version
codex --version
/opt/actions-runner/bin/Runner.Listener --version
chown -R agent:agent /opt/actions-runner
for path in /home/ubuntu/.codex/auth.json /home/agent/.codex/auth.json /root/.codex/auth.json /opt/actions-runner/.credentials /opt/actions-runner/.runner; do test ! -e "$path"; done
