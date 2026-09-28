#!/usr/bin/env bash
set -euo pipefail
# Seal only the disposable builder guest, after tool installation and validation.
node --version
profile="${1:-worker}"
if test "$profile" = worker; then codex --version; else ! command -v codex; fi
/opt/actions-runner/bin/Runner.Listener --version
for path in /home/admin/.codex/auth.json /home/agent/.codex/auth.json /root/.codex/auth.json /opt/actions-runner/.credentials /opt/actions-runner/.runner; do
  test ! -e "$path"
done
! findmnt --noheadings -t virtiofs | grep -q .
test "$(passwd -S admin | cut -d ' ' -f 2)" = L
test "$(passwd -S agent | cut -d ' ' -f 2)" = L
test ! -L /etc/resolv.conf
cmp /etc/resolv.conf <(printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:3 attempts:2\n')
getent ahostsv4 api.github.com >/dev/null
dpkg-query -W > /opt/factory/os-packages.txt
if test "$profile" = worker; then
  printf '{"schemaVersion":1,"purpose":"software-factory-worker","node":"%s","codex":"%s","runner":"%s"}\n' \
    "$(node --version)" "$(codex --version)" "$(/opt/actions-runner/bin/Runner.Listener --version)" > /opt/factory/image-manifest.json
else
  test "$profile" = swe-bench
  test ! -e /run/factory-evaluator
  test -z "$(docker ps -aq)"
  test -z "$(docker image ls -q)"
  test "$(git -C /opt/factory/swe-upstream rev-parse HEAD)" = 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e
  test -z "$(git -C /opt/factory/swe-upstream status --porcelain)"
  /opt/factory/swe-python/bin/pip check
  /opt/factory/swe-python/bin/pip freeze > /opt/factory/python-packages.txt
  printf '{"schemaVersion":1,"purpose":"software-factory-swe-bench","evaluatorRevision":"02e7a74ffd0b707aab73d203fe87bdc7c76afc8e","emulation":"amd64-on-arm64"}\n' > /opt/factory/image-manifest.json
  systemctl stop docker.service docker.socket containerd.service
fi
rm -f /var/lib/systemd/random-seed
truncate -s 0 /etc/machine-id
sync
