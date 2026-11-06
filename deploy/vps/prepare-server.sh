#!/usr/bin/env bash
# Runs once on a fresh Debian or Ubuntu VPS, as root: Docker, firewall, swap, security updates.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl ufw unattended-upgrades

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
docker info >/dev/null

# Small plans have no swap, and a brief memory spike would otherwise kill a container.
ram_mb="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
if [ "$(swapon --noheadings | wc -l)" -eq 0 ] && [ "$ram_mb" -lt 4096 ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' >/etc/sysctl.d/90-synctv.conf
fi

# SSH is the only way in. Allow the port of this very session so enabling cannot lock us out.
ssh_port="$(echo "${SSH_CONNECTION:-}" | awk '{print $4}')"
ufw default deny incoming
ufw default allow outgoing
ufw allow "${ssh_port:-22}/tcp"
ufw --force enable

systemctl enable --now unattended-upgrades
echo "Server prepared. Next: ./install.sh"
