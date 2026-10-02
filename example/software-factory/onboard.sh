#!/usr/bin/env bash
# One-command Software Factory onboarding: example/software-factory/onboard.sh
# Checks prerequisites, builds the runtime and the CLI when needed, then runs
# `software-factory init`. The hub runs the runtime from this checkout, pinned to its
# repository and pushed commit. Extra arguments are passed to init.
set -euo pipefail

# The Factory lives in example/software-factory; the runtime it builds on is the repository root.
root="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$root/package.json" ] && [ -d "$root/src/pipeline" ] || { echo 'Run onboard.sh from a checkout of the agent runtime repository.' >&2; exit 1; }
cd "$root"

# Color only on a terminal, and never when NO_COLOR is set (https://no-color.org).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  bold=$'\e[1m' dim=$'\e[2m' green=$'\e[32m' red=$'\e[31m' reset=$'\e[0m'
else
  bold='' dim='' green='' red='' reset=''
fi

fail() { echo "${red}✗ $*${reset}" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail 'Node.js 22.16 or later is required: https://nodejs.org'
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
  || fail "Node.js 22.16 or later is required (found $(node --version))."
command -v gh >/dev/null 2>&1 || fail 'The GitHub CLI is required: https://cli.github.com'
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo 'Sign in to GitHub first:'
  gh auth login --hostname github.com --web --scopes 'admin:org,repo,workflow'
fi

# Build only when sources or dependencies changed since the last build.
stamp="$root/example/software-factory/dist/.onboard-build"
fingerprint="$(git rev-parse HEAD 2>/dev/null || echo unknown)-$(git status --porcelain 2>/dev/null | shasum | cut -c1-12)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$fingerprint" ]; then
  echo "${bold}Preparing Software Factory on this computer${reset} ${dim}(first run takes about a minute; later runs skip this)${reset}"
  # Print each step as it starts and how long it took, so a slow install is not mistaken for a hang.
  step() {
    local label="$1" started=$SECONDS; shift
    printf '  %s·%s %s...' "$dim" "$reset" "$label"
    "$@"
    printf ' %sdone%s %s(%ss)%s\n' "$green" "$reset" "$dim" "$((SECONDS - started))" "$reset"
  }
  step 'Installing the runtime'\''s dependencies' npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --silent
  step 'Compiling the runtime' npm run --silent build
  step 'Installing the Software Factory CLI'\''s dependencies' npm --prefix example/software-factory ci --ignore-scripts --no-audit --no-fund --loglevel=error --silent
  step 'Compiling the Software Factory CLI' npm --prefix example/software-factory run --silent build
  echo "$fingerprint" > "$stamp"
  echo
fi

# The generated workflow runs this exact, already-pushed commit of this repository.
# Read the configured URL directly: `git remote get-url` applies insteadOf rewrites, which may embed tokens.
remote="$(git config --get remote.origin.url 2>/dev/null)" || fail 'Run onboard.sh from a git checkout of the runtime repository.'
runtime_repository="$(printf '%s' "$remote" | sed -E 's#^https://([^/@]*@)?github\.com/##; s#^(ssh://)?git@github\.com[:/]##; s#\.git$##')"
printf '%s' "$runtime_repository" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$' || fail "Cannot identify the GitHub repository for $remote."
runtime_revision="$(git rev-parse HEAD)"
gh api "repos/$runtime_repository/commits/$runtime_revision" --silent 2>/dev/null \
  || fail "Commit $runtime_revision is not on GitHub yet. Push it, then rerun."
extra=()
if [ "$(gh api "repos/$runtime_repository" --jq .private 2>/dev/null)" = true ]; then
  # A private runtime source is read by the hub alone, with a read-only deploy key onboarding creates and stores there
  # (in the secret its hub layout names).
  extra+=(--private-runtime)
fi

exec node example/software-factory/dist/actions-cli.js init \
  --runtime-repository "$runtime_repository" --runtime-revision "$runtime_revision" ${extra[@]+"${extra[@]}"} "$@"
