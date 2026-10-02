#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v semgrep >/dev/null 2>&1; then
  echo 'Semgrep CE is required (tested with 1.136.0).' >&2
  exit 2
fi

# CE runs locally. Do not authenticate to Semgrep AppSec or upload findings.
unset SEMGREP_APP_TOKEN
export SEMGREP_SEND_METRICS=off
semgrep scan --config p/security-audit --error --metrics=off --disable-version-check .
