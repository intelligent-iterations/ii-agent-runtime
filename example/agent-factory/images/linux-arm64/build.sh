#!/usr/bin/env bash
# Usage: build.sh NEW_STATE_DIRECTORY REGISTRY/IMAGE:TAG [worker|swe-bench]
# The registry is consumer-operated. Build guests contain no task credentials.
set -euo pipefail
recipe_dir="$(cd "$(dirname "$0")" && pwd)"
state_dir="$1"
destination="$2"
profile="${3:-worker}"
case "$profile" in worker) memory_mib=2048 ;; swe-bench) memory_mib=4096 ;; *) echo 'Unknown image profile' >&2; exit 1 ;; esac
mkdir -m 700 "$state_dir"
state_dir="$(cd "$state_dir" && pwd)"
export TART_HOME="$state_dir/tart"
export TART_NO_AUTO_PRUNE=1
image_name="build-$(uuidgen | tr '[:upper:]' '[:lower:]')"
printf '%s\n' "$image_name" > "$state_dir/owner"
value() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$recipe_dir/versions.json" "$1"; }
cleanup() {
  # Only this newly created Tart home and generated name are eligible for cleanup.
  if test "$(cat "$state_dir/owner")" = "$image_name"; then
    tart stop "$image_name" >/dev/null 2>&1 || true
    tart delete "$image_name" >/dev/null 2>&1 || true
    tart list --format json > "$state_dir/cleanup.json"
  fi
}
trap cleanup EXIT
cp "$recipe_dir/versions.json" "$state_dir/versions.json"
tart clone "$(value baseImage)" "$image_name"
tart set "$image_name" --cpu 2 --memory "$memory_mib" --random-mac
# Image provisioning uses ordinary NAT; runtime agent deployments require Softnet.
tart run "$image_name" --no-graphics --no-audio --no-clipboard > "$state_dir/vm.log" 2>&1 &
ready=false
for attempt in $(seq 1 30); do
  if tart exec "$image_name" true >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
$ready || { echo 'Guest not ready' >&2; exit 1; }
codex_version="$(value codex)"
if test "$profile" = swe-bench; then codex_version=none; fi
tart exec -i "$image_name" sudo bash -s -- "$(value node)" "$(value nodeSha256)" "$codex_version" "$(value actionsRunner)" "$(value actionsRunnerSha256)" < "$recipe_dir/provision.sh" > "$state_dir/provision.log" 2>&1
if test "$profile" = swe-bench; then
  cp "$recipe_dir/swe-bench-requirements.lock" "$state_dir/swe-bench-requirements.lock"
  tart exec -i "$image_name" sudo python3 -c "import sys;open('/opt/factory/swe-bench-requirements.lock','xb').write(sys.stdin.buffer.read())" < "$recipe_dir/swe-bench-requirements.lock"
  tart exec -i "$image_name" sudo bash -s < "$recipe_dir/provision-swe-bench.sh" > "$state_dir/evaluator-provision.log" 2>&1
fi
tart exec -i "$image_name" sudo bash -s -- "$profile" < "$recipe_dir/seal.sh" > "$state_dir/seal.log" 2>&1
tart stop "$image_name"
case "$destination" in
  127.0.0.1:*/*|localhost:*/*) tart push --insecure "$image_name" "$destination" ;;
  *) tart push "$image_name" "$destination" ;;
esac
printf 'Published %s; resolve its immutable digest before deployment.\n' "$destination"
