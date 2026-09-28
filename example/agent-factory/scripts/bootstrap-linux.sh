#!/usr/bin/env bash
set -euo pipefail

factory_prepare_linux() {
  local factory_checkout
  factory_checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64 || { echo 'Linux x64 is required' >&2; return 1; }
  test -e /dev/kvm || { echo 'KVM is unavailable on this host' >&2; return 1; }
  command -v apt-get >/dev/null || { echo 'This installer currently supports Debian/Ubuntu Linux' >&2; return 1; }
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends ca-certificates curl git jq gnupg unzip libvirt-daemon-system libvirt-clients libguestfs-tools qemu-utils ovmf acl
  sudo systemctl enable --now libvirtd.service

  if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)'; then
    local version sha archive
    version="$(node -e 'console.log(require(process.argv[1]).node)' "$factory_checkout/images/linux-x64/versions.json" 2>/dev/null || sed -n 's/.*"node": "\([^"]*\)".*/\1/p' "$factory_checkout/images/linux-x64/versions.json")"
    sha="$(sed -n 's/.*"nodeSha256": "\([^"]*\)".*/\1/p' "$factory_checkout/images/linux-x64/versions.json")"
    archive="$(mktemp)"
    curl -fsSL "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz" -o "$archive"
    printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status
    sudo tar -xJf "$archive" --strip-components=1 -C /usr/local
    rm -f "$archive"
  fi
  export PATH="/usr/local/bin:$PATH"
  if ! command -v tofu >/dev/null; then
    local installer
    installer="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL https://get.opentofu.org/install-opentofu.sh -o "$installer"
    chmod 700 "$installer"
    sudo "$installer" --install-method standalone --install-path /opt/opentofu
    rm -f "$installer"
  fi
  command -v tofu >/dev/null

  if ! id -nG | tr ' ' '\n' | grep -qx libvirt; then sudo usermod -aG libvirt "$(id -un)"; fi
  # Group enrollment survives future logins; the ACL lets this setup finish now.
  sudo setfacl -m "u:$(id -un):rw" /run/libvirt/libvirt-sock

  local pool_dir=/var/lib/libvirt/images/ii-factory
  local qemu_group
  qemu_group="$(id -gn libvirt-qemu)"
  sudo install -d -m 2770 -o "$(id -un)" -g "$qemu_group" "$pool_dir"
  if ! sudo virsh -c qemu:///system pool-info ii-factory >/dev/null 2>&1; then
    sudo virsh -c qemu:///system pool-define-as ii-factory dir --target "$pool_dir"
  fi
  sudo virsh -c qemu:///system pool-dumpxml ii-factory | grep -Fq "<path>$pool_dir</path>" || { echo 'Existing ii-factory pool points elsewhere' >&2; return 1; }
  if ! sudo virsh -c qemu:///system pool-info ii-factory | grep -Eq '^Active:[[:space:]]+yes'; then
    sudo virsh -c qemu:///system pool-start ii-factory >/dev/null
  fi
  sudo virsh -c qemu:///system pool-autostart ii-factory >/dev/null

  if ! sudo virsh -c qemu:///system net-info ii-factory >/dev/null 2>&1; then
    local network_xml
    network_xml="$(mktemp)"
    cat > "$network_xml" <<'XML'
<network>
  <name>ii-factory</name>
  <forward mode='nat'/>
  <bridge name='virbr-iif' stp='on' delay='0'/>
  <ip address='192.168.240.1' netmask='255.255.255.0'>
    <dhcp><range start='192.168.240.10' end='192.168.240.250'/></dhcp>
  </ip>
</network>
XML
    sudo virsh -c qemu:///system net-define "$network_xml"
    rm -f "$network_xml"
  fi
  sudo virsh -c qemu:///system net-dumpxml ii-factory | grep -Eq "<forward mode=['\"]nat['\"]" || { echo 'Existing ii-factory network is not NAT' >&2; return 1; }
  if ! sudo virsh -c qemu:///system net-info ii-factory | grep -Eq '^Active:[[:space:]]+yes'; then
    sudo virsh -c qemu:///system net-start ii-factory >/dev/null
  fi
  sudo virsh -c qemu:///system net-autostart ii-factory >/dev/null
  virsh -c qemu:///system nwfilter-dumpxml clean-traffic >/dev/null
  virsh -c qemu:///system net-info ii-factory >/dev/null
  virsh -c qemu:///system pool-info ii-factory >/dev/null
}
