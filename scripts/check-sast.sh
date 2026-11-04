#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# CE runs locally. Do not authenticate to Semgrep AppSec or upload findings.
unset SEMGREP_APP_TOKEN
export SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0

if ! command -v semgrep >/dev/null 2>&1; then
  echo 'Semgrep CE is required (tested with 1.136.0).' >&2
  exit 2
fi
if [[ "$(semgrep --version 2>/dev/null)" != '1.136.0' ]]; then
  echo 'Semgrep CE 1.136.0 is required; use the release scanner image or install this version.' >&2
  exit 2
fi

semgrep scan --config p/security-audit --config scripts/semgrep \
  --error --strict --metrics=off --disable-version-check "$@" .
