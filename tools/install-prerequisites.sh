#!/usr/bin/env bash
# Install what nerd needs on Ubuntu or Debian: Docker Engine (from Docker's own
# apt repository, with the buildx plugin), the user in group docker, the NVIDIA
# Container Toolkit (NVIDIA's apt repository) with docker's nvidia runtime and
# a CDI spec. The NVIDIA driver is only checked: installing a driver on someone
# else's machine by script can leave it without a display; the hint says how.
# Other systems: prints what to do. Every step is skipped when already done,
# so running it twice is safe. Finishes with tools/check-prerequisites.sh.
#
#   tools/install-prerequisites.sh          print the plan, change nothing (default)
#   tools/install-prerequisites.sh --yes    do it (uses sudo)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)

act=0
for a in "$@"; do
  case "$a" in
    --yes|-y) act=1 ;;
    --dry-run) act=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument '$a' (--dry-run, --yes)" >&2; exit 2 ;;
  esac
done

sudo=""; [ "$(id -u)" = 0 ] || sudo=sudo
say() { echo "== $*"; }
# sh -c string, run as root; printed in the plan. Fails the script on error.
root() {
  if [ $act = 0 ]; then echo "   would run: $1"; return 0; fi
  echo "   + $1"
  $sudo sh -c "$1" || { echo "FAILED: $1" >&2; exit 1; }
}

[ $act = 0 ] && echo "Dry run: nothing is changed. Run with --yes to do it." && echo

if [ "$(uname -s)" != Linux ]; then
  cat <<'EOF'
This is not Linux. nerd runs on Linux with an NVIDIA GPU, or on Windows through
WSL2: install the NVIDIA driver on Windows, create a WSL2 Ubuntu distribution,
clone nerd inside it and run this script there. See docs/INSTALL.md.
EOF
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
id_like=" ${ID:-} ${ID_LIKE:-} "
if [[ "$id_like" != *" ubuntu "* && "$id_like" != *" debian "* ]]; then
  cat <<EOF
${PRETTY_NAME:-This distribution} is not Ubuntu or Debian; install by hand:
  - Docker Engine and the buildx plugin: https://docs.docker.com/engine/install/
  - the NVIDIA driver for your GPU:     https://www.nvidia.com/Download/index.aspx
  - NVIDIA Container Toolkit:           https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
    then: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
          sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
  - your user in group docker:          sudo usermod -aG docker \$USER (log in again)
Then: tools/check-prerequisites.sh
EOF
  exit 1
fi

# Docker's repository is per distribution: ubuntu or debian, and the codename
# of the base release (Ubuntu derivatives carry UBUNTU_CODENAME).
if [[ "$id_like" == *" ubuntu "* ]]; then repo=ubuntu codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
else repo=debian codename=${VERSION_CODENAME:-}; fi
wsl=0; grep -qi microsoft /proc/version 2>/dev/null && wsl=1
changed_docker=0

# 1. Docker Engine with buildx and compose (./UP runs docker compose, decision 0012).
say "1. Docker Engine ($repo $codename)"
if command -v docker >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "   already installed: $(docker --version), $(docker compose version --short 2>/dev/null)"
elif command -v docker >/dev/null 2>&1 && dpkg -s docker-ce >/dev/null 2>&1; then
  root "apt-get update && apt-get install -y docker-buildx-plugin docker-compose-plugin"
elif command -v docker >/dev/null 2>&1; then
  echo "   docker is installed but not from Docker's repository (docker.io, snap or Docker Desktop)."
  echo "   It needs the buildx and compose plugins: sudo apt-get install docker-buildx docker-compose-v2 (Ubuntu's) or switch to docker-ce:"
  echo "   https://docs.docker.com/engine/install/$repo/ (remove the other packages first). Not changed by this script."
else
  root "apt-get update && apt-get install -y ca-certificates curl gnupg"
  root "install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/$repo/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc"
  root "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$repo $codename stable\" > /etc/apt/sources.list.d/docker.list"
  root "apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  changed_docker=1
fi
if [ -d /run/systemd/system ]; then
  if systemctl is-active --quiet docker 2>/dev/null; then echo "   docker service running"
  else root "systemctl enable --now docker"; fi
else
  echo "   no systemd: start the daemon with 'sudo service docker start'$([ $wsl = 1 ] && echo ' (or enable systemd in /etc/wsl.conf: [boot] systemd=true)')"
  [ $act = 1 ] && { $sudo service docker start >/dev/null 2>&1 || true; }
fi

# 2. The user in group docker (root-equivalent: anyone in it controls the machine).
user=${SUDO_USER:-$(id -un)}
say "2. $user in group docker"
if [ "$user" = root ]; then echo "   root: not needed"
elif id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then echo "   already"
else root "usermod -aG docker $user"; echo "   log out and in again (or: newgrp docker) for it to take effect"; fi

# 3. NVIDIA driver: check only.
say "3. NVIDIA driver (checked, not installed)"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  echo "   present: $(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -1)"
  driver=1
else
  driver=0
  if [ $wsl = 1 ]; then
    echo "   MISSING: install the NVIDIA driver on Windows (https://www.nvidia.com/Download/index.aspx); WSL2 gets the GPU from it. Do not install a Linux driver inside WSL."
  else
    echo "   MISSING: install it yourself and reboot: https://www.nvidia.com/Download/index.aspx"
    [ "$repo" = ubuntu ] && echo "   on Ubuntu: sudo ubuntu-drivers list; sudo ubuntu-drivers install"
  fi
fi

# 4. NVIDIA Container Toolkit.
say "4. NVIDIA Container Toolkit"
if command -v nvidia-ctk >/dev/null 2>&1; then
  echo "   already installed: $(nvidia-ctk --version 2>/dev/null | head -1)"
else
  root "apt-get update && apt-get install -y curl gnupg"
  root "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg"
  root "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list"
  root "apt-get update && apt-get install -y nvidia-container-toolkit"
fi

# 5. docker's nvidia runtime (for --gpus all) and a CDI spec (--device nvidia.com/gpu=all).
say "5. GPU in docker: runtime and CDI spec"
if command -v docker >/dev/null 2>&1 && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
  echo "   docker already has the nvidia runtime"
elif [ $act = 0 ] || command -v nvidia-ctk >/dev/null 2>&1; then
  root "nvidia-ctk runtime configure --runtime=docker"
  changed_docker=1
fi
if compgen -G '/etc/cdi/nvidia*.yaml' >/dev/null || compgen -G '/var/run/cdi/nvidia*.yaml' >/dev/null; then
  echo "   CDI spec already present"
elif [ $driver = 0 ]; then
  echo "   CDI spec: generated after the driver is installed (run this script again)"
else
  root "nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
fi
if [ $changed_docker = 1 ]; then
  if [ -d /run/systemd/system ]; then root "systemctl restart docker"; else root "service docker restart"; fi
fi

echo
if [ $act = 0 ]; then
  echo "That was the plan. Run with --yes to do it. Current state:"
else
  echo "Done. Checking the machine:"
fi
echo
exec "$here/check-prerequisites.sh"
