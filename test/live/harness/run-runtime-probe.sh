#!/bin/sh
set -eu
context=$1
artifacts=$2
owner=$3
registry=$4
case "$owner" in *[!a-z0-9-]*|'') exit 2 ;; esac
case "$registry" in *[!a-zA-Z0-9.:-]*|'') exit 2 ;; esac
name="runtime-integration-$owner"
tag="$registry/ii/runtime-proof-$owner:proof"
completed=0
cleanup() {
  if [ "$completed" != 1 ]; then
    printf '{"confirmed":false,"preservedController":"%s"}\n' "$name" > "$artifacts/controller-cleanup.json"
    return 1
  fi
  test "$(docker inspect "$name" --format '{{index .Config.Labels "runtime.proof-owner"}}')" = "$owner" || return 1
  docker rm "$name" >/dev/null
  printf '{"confirmed":true,"imageCacheRetained":true}\n' > "$artifacts/controller-cleanup.json"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
DOCKER_BUILDKIT=0 timeout 600 docker build --pull=false --memory=1073741824 --memory-swap=1073741824 \
  --cpu-period=100000 --cpu-quota=100000 --label "runtime.proof-owner=$owner" \
  -f "$context/test/live/harness/Dockerfile.runtime" -t "$tag" "$context" > "$artifacts/build.log" 2>&1
docker push "$tag" > "$artifacts/push.log" 2>&1
image=$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')
case "$image" in "$registry/ii/runtime-proof-$owner@sha256:"*) ;; *) exit 1 ;; esac
printf '{"image":"%s"}\n' "$image" > "$artifacts/image.json"
set +e
timeout 720 docker run --name "$name" --label "runtime.proof-owner=$owner" \
  --cpus=1 --memory=1073741824 --memory-swap=1073741824 --pids-limit=256 \
  --network=host --cap-add=NET_ADMIN \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  "$image" "$image" > "$artifacts/proof.json" 2> "$artifacts/proof.stderr"
status=$?
set -e
printf '{"exitCode":%s}\n' "$status" > "$artifacts/result.json"
# Preserve the controller's IaC state on an unconfirmed cleanup; never discard
# the only recovery evidence or report a cleaned nested deployment in that case.
if grep -q '"cleanupConfirmed":true' "$artifacts/proof.json"; then completed=1; fi
exit "$status"
