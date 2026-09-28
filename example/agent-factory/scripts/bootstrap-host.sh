#!/bin/bash
# Sourced by setup.sh; this function is also exercised with isolated command fixtures.
factory_prepare_host() {
  if ! command -v brew >/dev/null; then
    factory_installer="$(mktemp -t factory-homebrew)"
    trap 'rm -f "$factory_installer"' EXIT
    curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$factory_installer"
    /bin/bash "$factory_installer"
    rm -f "$factory_installer"
    trap - EXIT
  fi
  for factory_dependency in 'node:node@22' 'tofu:opentofu' 'tart:cirruslabs/cli/tart' 'softnet:cirruslabs/cli/softnet'; do
    factory_binary="${factory_dependency%%:*}"
    factory_formula="${factory_dependency#*:}"
    if ! command -v "$factory_binary" >/dev/null; then brew install "$factory_formula"; fi
  done
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)'; then
    brew install node@22
  fi
  factory_softnet="$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$(command -v softnet)")"
  if [ ! -u "$factory_softnet" ] || [ "$(stat -f '%u' "$factory_softnet")" != 0 ]; then
    echo 'Configuring Softnet so ephemeral VMs can start without an interactive sudo prompt.'
    sudo chown root:wheel "$factory_softnet"
    sudo chmod u+s "$factory_softnet"
  fi
}
