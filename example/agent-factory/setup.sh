#!/bin/bash
set -euo pipefail

factory_checkout="$(cd "$(dirname "$0")" && pwd)"
cd "$factory_checkout"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
    . "$factory_checkout/scripts/bootstrap-host.sh"
    factory_prepare_host ;;
  Linux:x86_64)
    . "$factory_checkout/scripts/bootstrap-linux.sh"
    factory_prepare_linux ;;
  *) echo 'Use an Apple Silicon Mac or Linux x64 KVM host.' >&2; exit 1 ;;
esac
mkdir -p "$factory_checkout/.factory"
chmod 700 "$factory_checkout/.factory"
# Build the standalone runtime before installing its local example consumer.
npm --prefix ../.. ci --no-audit --no-fund --progress=false
npm ci --no-audit --no-fund --progress=false --cache "$factory_checkout/.factory/npm-cache"
npm run build
exec node scripts/onboard.mjs "$@"
