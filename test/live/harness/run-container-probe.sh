#!/bin/sh
# Run only within an admitted infrastructure-build lease with Docker access.
set -eu
context=$1
artifacts=$2
owner=$3
test "$#" = 3
profile="ii-runtime-proof-$owner"
case "$owner" in *[!a-z0-9-]*|'') exit 2 ;; esac
case "$profile" in *[!a-zA-Z0-9_.-]*|'') exit 2 ;; esac
test -d "$context"
test -d "$artifacts"
name="runtime-executor-proof-$owner"
tag="$name:proof"
policy_attempted=0
policy() {
  printf 'abi <abi/4.0>,\nprofile %s flags=(unconfined) { userns, }\n' "$profile" |
    docker run --rm --name "$name-policy" --label "runtime.proof-owner=$owner" \
      --cpus=0.25 --memory=134217728 --memory-swap=134217728 --pids-limit=32 \
      --network=none --read-only --cap-drop=ALL --cap-add=MAC_ADMIN \
      --security-opt apparmor=unconfined --security-opt no-new-privileges \
      --mount type=bind,source=/sys/kernel/security,target=/sys/kernel/security \
      --entrypoint /sbin/apparmor_parser -i "$tag" --skip-cache "$1" /dev/stdin
}
cleanup() {
  if docker inspect "$name" >/dev/null 2>&1; then
    test "$(docker inspect "$name" --format '{{index .Config.Labels "runtime.proof-owner"}}')" = "$owner" || return 1
    docker rm -f "$name" >/dev/null || return 1
  fi
  if [ "$policy_attempted" = 1 ]; then
    policy --remove > "$artifacts/policy-remove.log" 2>&1 || return 1
  fi
  if docker image inspect "$tag" >/dev/null 2>&1; then
    test "$(docker image inspect "$tag" --format '{{index .Config.Labels "runtime.proof-owner"}}')" = "$owner" || return 1
    docker image rm "$tag" >/dev/null || return 1
  fi
  printf '{"runtimeAbsent":true,"ownedImageRemoved":true,"ownedPolicyRemoved":true}\n' > "$artifacts/nested-cleanup.json"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Legacy builder honors per-build cgroup caps; keep the nested proof within
# the outer lease's explicitly reserved CPU/RAM and bounded wall time.
DOCKER_BUILDKIT=0 docker build --pull=false --memory=1073741824 --memory-swap=1073741824 \
  --cpu-period=100000 --cpu-quota=100000 --label "runtime.proof-owner=$owner" \
  -t "$tag" "$context" > "$artifacts/build.log" 2>&1
policy_attempted=1
policy --add > "$artifacts/policy-add.log" 2>&1
set +e
timeout 150 docker run --name "$name" --label "runtime.proof-owner=$owner" \
  --cpus=1 --memory=1073741824 --memory-swap=1073741824 --pids-limit=256 \
  --network=none --security-opt "apparmor=$profile" --security-opt seccomp=unconfined \
  "$tag" > "$artifacts/proof.json" 2> "$artifacts/proof.stderr"
status=$?
set -e
printf '{"exitCode":%s}\n' "$status" > "$artifacts/result.json"
exit "$status"
