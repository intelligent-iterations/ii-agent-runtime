#!/usr/bin/env bash
# Usage: build.sh STATE_DIRECTORY. Prints an immutable libvirt volume reference.
set -euo pipefail
recipe_dir="$(cd "$(dirname "$0")" && pwd)"
state_dir="$1"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
state_dir="$(cd "$state_dir" && pwd)"
value() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$recipe_dir/versions.json" "$1"; }
base="$state_dir/base.qcow2"
built="$state_dir/worker.qcow2"
pending="$state_dir/worker.pending.qcow2"
recipe_digest="$(sha256sum "$recipe_dir/versions.json" "$recipe_dir/provision.sh" "$recipe_dir/build.sh" | awk '{print $1}' | sha256sum | cut -d ' ' -f 1)"
if test -f "$built"; then
  test -f "$state_dir/recipe.digest" && test "$(cat "$state_dir/recipe.digest")" = "$recipe_digest" || {
    echo 'Image recipe changed or build was interrupted; use a new installation directory' >&2; exit 1;
  }
fi
pool=ii-factory
if test ! -f "$built"; then
  if test ! -f "$base"; then
    curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' "$(value baseImage)" --output "$base"
  fi
  printf '%s  %s\n' "$(value baseSha256)" "$base" | sha256sum --check --status
  rm -f "$pending"
  qemu-img create -f qcow2 "$pending" 16G >/dev/null
  virt-resize --expand /dev/sda1 "$base" "$pending" > "$state_dir/resize.log" 2>&1
  virt-customize --add "$pending" --copy-in "$recipe_dir/provision.sh:/root" \
    --run-command "bash /root/provision.sh $(value node) $(value nodeSha256) $(value codex) $(value actionsRunner) $(value actionsRunnerSha256)" \
    --delete /root/provision.sh > "$state_dir/provision.log" 2>&1
  mv "$pending" "$built"
  printf '%s\n' "$recipe_digest" > "$state_dir/recipe.digest"
  rm -f "$base"
fi
digest="$(sha256sum "$built" | cut -d ' ' -f 1)"
name="factory-worker-${digest}.qcow2"
pool_dir="$(virsh -c qemu:///system pool-dumpxml "$pool" | sed -n "s:.*<path>\(.*\)</path>.*:\1:p" | head -1)"
test -n "$pool_dir" && test -d "$pool_dir"
if test ! -f "$pool_dir/$name"; then
  published="$pool_dir/.factory-worker-$$.pending"
  install -m 0644 "$built" "$published"
  printf '%s  %s\n' "$digest" "$published" | sha256sum --check --status
  mv "$published" "$pool_dir/$name"
  virsh -c qemu:///system pool-refresh "$pool" >/dev/null
fi
printf '%s  %s\n' "$digest" "$pool_dir/$name" | sha256sum --check --status
printf '%s@sha256:%s\n' "$name" "$digest"
