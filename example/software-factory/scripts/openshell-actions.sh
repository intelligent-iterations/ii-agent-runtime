#!/usr/bin/env bash
# Ephemeral OpenShell provider infrastructure for one trusted GitHub Actions job.
set -euo pipefail
root="${RUNNER_TEMP:?}/ii-openshell"
case "${1:-}" in
  stop)
    if [ ! -f "$root/gateway.pid" ]; then exit 0; fi
    pid=$(cat "$root/gateway.pid")
    if [ -e "/proc/$pid/exe" ]; then
      test "$(readlink "/proc/$pid/exe")" = "$root/package/usr/bin/openshell-gateway"
      kill "$pid"
      for attempt in $(seq 1 20); do
        [ ! -e "/proc/$pid/exe" ] && break
        sleep 1
      done
      test ! -e "/proc/$pid/exe"
    fi
    # The job's sandbox cleanup must precede provider teardown.
    test -z "$(docker ps -aq --filter label=openshell.ai/sandbox-namespace=ii-actions)"
    rm -rf -- "$root"
    exit 0 ;;
  start) ;;
  *) echo 'Usage: openshell-actions.sh start|stop' >&2; exit 2 ;;
esac
[ "${GITHUB_ACTIONS:-}" = true ] && [ "$(uname -sm)" = 'Linux x86_64' ]
umask 077
mkdir "$root"
export XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" OPENSHELL_TELEMETRY_ENABLED=false OPENSHELL_COLOR=never
mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME"
curl --fail --location --silent --show-error --retry 3 \
  https://github.com/NVIDIA/OpenShell/releases/download/v0.1.2/openshell_0.1.2-1_amd64.deb -o "$root/openshell.deb"
printf '%s  %s\n' 1f5416ea08f32fdc621f20a2cc0324298e60aba8bbe996459d9e3b44195f23df "$root/openshell.deb" | sha256sum --check -
dpkg-deb --extract "$root/openshell.deb" "$root/package"
export PATH="$root/package/usr/bin:$PATH"
address=$(ip -j route get 1.1.1.1 | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s)[0]?.prefsrc;if(!require("net").isIPv4(a))process.exit(1);console.log(a)})')
openshell-gateway generate-certs --output-dir "$root/tls" --server-san "$address" --server-san host.openshell.internal > "$root/cert-generation.log" 2>&1
cat > "$root/gateway.toml" <<CONFIG
[openshell]
version = 2
[openshell.gateway]
name = "ii-actions"
bind_address = "$address:17670"
compute_driver = "docker"
guest_tls_ca = "$root/tls/ca.crt"
guest_tls_cert = "$root/tls/client/tls.crt"
guest_tls_key = "$root/tls/client/tls.key"
[openshell.gateway.tls]
cert_path = "$root/tls/server/tls.crt"
key_path = "$root/tls/server/tls.key"
client_ca_path = "$root/tls/ca.crt"
[openshell.gateway.mtls_auth]
enabled = true
[openshell.gateway.gateway_jwt]
signing_key_path = "$root/tls/jwt/signing.pem"
public_key_path = "$root/tls/jwt/public.pem"
kid_path = "$root/tls/jwt/kid"
gateway_id = "ii-actions"
[openshell.drivers.docker]
sandbox_runtime_image = "ghcr.io/nvidia/openshell/sandbox:0.1.2"
supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.1.2"
image_pull_policy = "if_not_present"
sandbox_label = "ii-actions"
grpc_endpoint = "https://$address:17670"
app_armor_profile = "Unconfined"
CONFIG
openshell-gateway config preflight --path "$root/gateway.toml"
nohup openshell-gateway --config "$root/gateway.toml" > "$root/gateway.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$root/gateway.pid"
client="$XDG_CONFIG_HOME/openshell/gateways/actions/mtls"
mkdir -p "$client"
cp "$root/tls/ca.crt" "$root/tls/client/tls.crt" "$root/tls/client/tls.key" "$client/"
openshell gateway add "https://$address:17670" --local --name actions
for attempt in $(seq 1 30); do
  openshell status > "$root/status.log" 2>&1 && break
  sleep 1
done
openshell status
openshell settings set --global --key agent_policy_proposals_enabled --value false --yes
printf '%s\n' "$root/package/usr/bin" >> "${GITHUB_PATH:?}"
printf '%s\n' "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" "XDG_STATE_HOME=$XDG_STATE_HOME" \
  'OPENSHELL_TELEMETRY_ENABLED=false' "FACTORY_WORKER_GATEWAY_ADDRESS=$address" >> "${GITHUB_ENV:?}"
