#!/usr/bin/env bash
# Can this machine run nerd? One pass over everything, one table:
#   OK       fine
#   WARN     works, but read the hint (slow, tight, unchecked)
#   MISSING  ./UP will fail until this is fixed; the hint says how
# Exit 0 when nothing is MISSING, 1 otherwise. Reads .env for the variant,
# context and ports (see env.example). Changes nothing on the machine.
#
#   tools/check-prerequisites.sh            the check
#   tools/check-prerequisites.sh --offline  skip the network checks
set -uo pipefail
# shellcheck source=tools/lib.sh
. "$(dirname "$0")/lib.sh"

offline=0
for a in "$@"; do
  case "$a" in
    --offline) offline=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument '$a' (--offline)" >&2; exit 2 ;;
  esac
done

nerd_load_env
nerd_settings

missing=0 warn=0
row() {
  # row STATUS ITEM DETAIL [HINT]
  printf '%-8s %-16s %s\n' "$1" "$2" "$3"
  [ -n "${4:-}" ] && printf '%-8s %-16s -> %s\n' "" "" "$4"
  case "$1" in MISSING) missing=$((missing + 1)) ;; WARN) warn=$((warn + 1)) ;; esac
  return 0
}

printf '%-8s %-16s %s\n' STATUS ITEM DETAIL
printf '%-8s %-16s %s\n' ------ ---- ------

# --- OS and CPU architecture -------------------------------------------------
os=$(uname -s) arch=$(uname -m) wsl=0
grep -qi microsoft /proc/version 2>/dev/null && wsl=1
pretty=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}") )
if [ "$os" = Darwin ]; then
  if [ "$arch" = arm64 ]; then row OK os "macOS $(sw_vers -productVersion 2>/dev/null) $arch (llama-server on the host with Metal, docs/MACOS.md)"
  else row MISSING os "macOS $arch" "only Apple silicon Macs: an Intel Mac has no Metal GPU fast enough for the model"; fi
  [ "$NERD_LLAMA" = host ] || row MISSING llama-mode "NERD_LLAMA=$NERD_LLAMA" "on macOS the server must run on the host: NERD_LLAMA=host (or leave it unset)"
  bv=${BASH_VERSINFO[0]}
  [ "$bv" -ge 4 ] || row MISSING bash "bash $BASH_VERSION (macOS ships 3.2)" "brew install bash (./UP and ./STATUS need bash 4+, first in PATH)"
elif [ "$os" != Linux ]; then
  row MISSING os "$os $arch" "nerd runs on Linux (or Windows through WSL2), or macOS on Apple silicon; see docs/INSTALL.md"
else
  case "$arch" in
    x86_64|aarch64) row OK os "${pretty:-Linux} $arch$([ $wsl = 1 ] && echo ', WSL2')" ;;
    *) row MISSING os "$pretty $arch" "only x86_64 and aarch64 are supported" ;;
  esac
fi

# --- tools the scripts use ------------------------------------------------------
for t in git curl; do
  if command -v "$t" >/dev/null 2>&1; then row OK "$t" "$(command -v "$t")"
  else row MISSING "$t" "not found" "sudo apt-get install $t (or your OS's package)"; fi
done

# --- docker ---------------------------------------------------------------------
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then
  row MISSING docker "not installed" "tools/install-prerequisites.sh (Docker Engine from docker.com)"
else
  ver=$(docker version --format '{{.Client.Version}}' 2>/dev/null)
  if out=$(docker info 2>&1 >/dev/null); then
    docker_ok=1
    sver=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
    row OK docker "client ${ver:-?}, engine ${sver:-?}, usable by $(id -un)"
  elif grep -qi 'permission denied' <<< "$out"; then
    row MISSING docker "client ${ver:-?}; $(id -un) may not use the daemon" "sudo usermod -aG docker $(id -un), then log in again (the docker group is root-equivalent)"
  else
    row MISSING docker "client ${ver:-?}; daemon not reachable" "sudo systemctl enable --now docker (or: sudo service docker start)"
  fi
  # The Dockerfile uses RUN --mount, which needs BuildKit (the buildx plugin).
  if docker buildx version >/dev/null 2>&1; then
    row OK buildx "$(docker buildx version 2>/dev/null | awk '{print $2}')"
  else
    row MISSING buildx "docker buildx plugin not found (BuildKit is needed to build)" "sudo apt-get install docker-buildx-plugin (Docker's repo) or tools/install-prerequisites.sh"
  fi
fi

# --- llama-server on the host (NERD_LLAMA=host) ------------------------------------
gpu_ok=0 vram_mib="" cc=""
if [ "$NERD_LLAMA" = host ]; then
  for t in cmake c++; do
    if command -v "$t" >/dev/null 2>&1; then row OK "$t" "$(command -v "$t") (to build llama-server)"
    else row MISSING "$t" "not found (tools/llama-host.sh build needs it)" "macOS: xcode-select --install; brew install cmake"; fi
  done
  hd=${NERD_HOST_DIR:-$HOME/.nerd}
  if nerd_host_llama_up; then row OK llama-host "a llama-server answers on 127.0.0.1:$NERD_LLAMA_PORT"
  elif [ -x "$hd/llama.cpp/build/bin/llama-server" ]; then row WARN llama-host "built, not running" "./UP starts it"
  else row WARN llama-host "not built yet" "./UP builds it, downloads the model and starts it"; fi
  # Unified memory: the model and its KV cache come out of RAM, and macOS lets
  # the GPU have about two thirds of it.
  case "$NERD_MODEL_VARIANT" in q2) base=7200 ;; *) base=5900 ;; esac
  need_mib=$(( base + NERD_CTX * 23 / 1024 ))
  mem=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  gpu_mib=$(( mem / 1024 / 1024 * 2 / 3 ))
  if [ "$gpu_mib" -gt 0 ] && [ "$need_mib" -gt "$gpu_mib" ]; then
    row MISSING memory "$NERD_MODEL_VARIANT at context $NERD_CTX needs about $need_mib MiB; the GPU may use about $gpu_mib" "NERD_CTX=32768 in .env, or NERD_MODEL_VARIANT=q1"
  elif [ "$gpu_mib" -gt 0 ]; then
    row OK memory "$NERD_MODEL_VARIANT at context $NERD_CTX needs about $need_mib MiB of about $gpu_mib the GPU may use"
  fi
elif ! command -v nvidia-smi >/dev/null 2>&1; then
  if [ $wsl = 1 ]; then hint="install the NVIDIA driver on Windows (it provides the GPU to WSL2); do not install one inside WSL"
  else hint="install the NVIDIA driver for your GPU: https://www.nvidia.com/Download/index.aspx (Ubuntu: sudo ubuntu-drivers install)"; fi
  row MISSING nvidia-driver "nvidia-smi not found" "$hint"
elif ! q=$(nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader,nounits 2>/dev/null) || [ -z "$q" ]; then
  row MISSING nvidia-driver "nvidia-smi found but sees no GPU" "check the driver: nvidia-smi; reboot after a driver install"
else
  gpu_ok=1
  IFS=, read -r gname gdrv gmem cc <<< "$(head -1 <<< "$q")"
  gname=${gname# } gdrv=${gdrv# } gmem=${gmem# } cc=${cc# }
  dcuda=$(nerd_driver_cuda)
  row OK nvidia-driver "$gdrv (CUDA up to ${dcuda:-?}), $gname, compute capability $cc"
  [ "$(grep -c . <<< "$q")" -gt 1 ] && row WARN gpus "$(grep -c . <<< "$q") GPUs; the container gets all, llama-server uses them together" "add NERD_DOCKER_ARGS=\"-e CUDA_VISIBLE_DEVICES=0\" to pin one"
  [[ "$gmem" =~ ^[0-9]+$ ]] && vram_mib=$gmem
  # The image's CUDA must not be newer than the driver supports.
  need=${NERD_CUDA_VERSION%.*}
  if [ -n "$dcuda" ] && ! nerd_ver_ge "$dcuda" "$need"; then
    row MISSING cuda "image needs CUDA $NERD_CUDA_VERSION, the driver supports $dcuda" "update the NVIDIA driver, or set NERD_CUDA_VERSION in .env to one the driver supports (12.4.1 needs driver 550+)"
  else
    row OK cuda "build: CUDA_ARCH=$NERD_CUDA_ARCH CUDA_VERSION=$NERD_CUDA_VERSION, server image $NERD_SERVER_IMAGE"
  fi
  # Compute capability 7.5 and up is what the fork's CUDA code targets well;
  # older cards are untested.
  ccn=${cc/./}
  if [[ "$ccn" =~ ^[0-9]+$ ]] && [ "$ccn" -lt 75 ]; then
    row WARN gpu-arch "compute capability $cc is older than Turing; untested"
  fi
fi

# --- container toolkit / CDI --------------------------------------------------------
if [ "$NERD_LLAMA" = host ]; then
  :   # no GPU in the container
elif [ $docker_ok = 1 ]; then
  cdi=0 rt=0
  nerd_have_cdi && nerd_docker_cdi && cdi=1
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && rt=1
  hook=0; command -v nvidia-container-runtime-hook >/dev/null 2>&1 && hook=1
  if [ $cdi = 1 ]; then
    row OK gpu-in-docker "CDI spec present, docker resolves it: --device nvidia.com/gpu=all"
  elif [ $rt = 1 ] || [ $hook = 1 ]; then
    row OK gpu-in-docker "nvidia-container-toolkit: --gpus all"
  elif nerd_have_cdi; then
    row MISSING gpu-in-docker "CDI spec present but this docker does not resolve CDI devices" "Docker 28.2+ does by default; older: add {\"features\":{\"cdi\":true}} to /etc/docker/daemon.json and restart docker"
  else
    row MISSING gpu-in-docker "neither nvidia-container-toolkit nor a CDI spec" "tools/install-prerequisites.sh (installs the toolkit and generates the CDI spec)"
  fi
  [ "$NERD_GPU" != auto ] && row WARN gpu-mode "NERD_GPU=$NERD_GPU forced in .env (auto picks: $(nerd_gpu_args))"
elif command -v nvidia-ctk >/dev/null 2>&1 || command -v nvidia-container-runtime-hook >/dev/null 2>&1 || nerd_have_cdi; then
  row WARN gpu-in-docker "NVIDIA container toolkit or CDI spec present; docker's side not checked (docker unusable)"
else
  row MISSING gpu-in-docker "neither nvidia-container-toolkit nor a CDI spec" "tools/install-prerequisites.sh (installs the toolkit and generates the CDI spec)"
fi

# --- VRAM against the variant and context --------------------------------------------
# Measured with KV cache q4_0, one slot: Q1 needs 6.5 GiB at 32K and 7.2 GiB at
# 64K (about 23 KiB per token of context on top of ~5.8 GiB); Q2's weights are
# 6.7 GiB alone. Overflow is silent on some drivers (WSL2/WDDM: no error, 3-8x
# slower), so it is better caught here.
case "$NERD_MODEL_VARIANT" in q2) base=7200 ;; *) base=5900 ;; esac
need_mib=$(( base + NERD_CTX * 23 / 1024 ))
if [ $gpu_ok = 1 ]; then
  if [ -z "$vram_mib" ]; then
    # Unified memory (GB10 and similar): nvidia-smi reports no total.
    row OK vram "unified memory (no dedicated total); $NERD_MODEL_VARIANT at ${NERD_CTX} needs about $((need_mib / 1024)).$(( (need_mib % 1024) * 10 / 1024 )) GiB of it"
  elif [ "$need_mib" -le $((vram_mib - 512)) ]; then
    row OK vram "$vram_mib MiB; $NERD_MODEL_VARIANT at context $NERD_CTX needs about $need_mib MiB"
  elif [ "$need_mib" -le "$vram_mib" ]; then
    row WARN vram "$vram_mib MiB; $NERD_MODEL_VARIANT at context $NERD_CTX needs about $need_mib MiB: tight" "close other GPU users (a desktop takes 200-500 MiB) or set NERD_CTX=32768 in .env"
  else
    if [ "$NERD_MODEL_VARIANT" = q2 ]; then h="NERD_MODEL_VARIANT=q1 in .env"; else h="NERD_CTX=32768 in .env (Q1 at 32K: about 6.6 GiB)"; fi
    row MISSING vram "$vram_mib MiB; $NERD_MODEL_VARIANT at context $NERD_CTX needs about $need_mib MiB" "$h"
  fi
fi

# --- RAM -----------------------------------------------------------------------------
ram_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)
[ -z "$ram_kib" ] && ram_kib=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))
[ "$ram_kib" = 0 ] && ram_kib=""
if [ -n "$ram_kib" ]; then
  ram_gib=$((ram_kib / 1024 / 1024))
  if [ "$ram_gib" -lt 8 ]; then row MISSING ram "${ram_gib} GiB" "at least 8 GiB, 16 recommended (model file, Node, Chromium, the build)"
  elif [ "$ram_gib" -lt 15 ]; then row WARN ram "${ram_gib} GiB" "16 GiB recommended$([ $wsl = 1 ] && echo '; WSL2 gets half of the Windows RAM by default (.wslconfig memory=)')"
  else row OK ram "${ram_gib} GiB"; fi
fi

# --- disk -----------------------------------------------------------------------------
# Image 4-6 GB, the CUDA devel base and build cache about 8 GB more while
# building, the model 6-7 GB.
droot=/var/lib/docker
[ $docker_ok = 1 ] && droot=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
probe=$droot; while [ ! -d "$probe" ] && [ "$probe" != / ]; do probe=$(dirname "$probe"); done
free_gib=$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')
have_img=0; [ $docker_ok = 1 ] && docker image inspect "$NERD_IMAGE" >/dev/null 2>&1 && have_img=1
want=22; [ $have_img = 1 ] && want=8
if [ -z "$free_gib" ]; then row WARN disk "cannot read free space of $droot"
elif [ "$free_gib" -lt $((want / 2 + 2)) ]; then row MISSING disk "$free_gib GiB free at $droot" "about $want GiB needed ($([ $have_img = 1 ] && echo 'model' || echo 'build, image and model')); docker system prune, or move docker's data-root"
elif [ "$free_gib" -lt "$want" ]; then row WARN disk "$free_gib GiB free at $droot" "about $want GiB recommended; after the build: docker builder prune frees the build cache"
else row OK disk "$free_gib GiB free at $droot$([ $have_img = 1 ] && echo ", image $NERD_IMAGE present")"; fi

# --- ports --------------------------------------------------------------------------------
if [ -n "${NERD_NETWORK:-}" ]; then
  row WARN ports "NERD_NETWORK=$NERD_NETWORK: ports are not published; not checked" "containers sharing one network need different NERD_SSH_PORT/NERD_APP_PORT/NERD_LLAMA_PORT"
else
  ours=""; [ $docker_ok = 1 ] && ours=$(docker port "$NERD_NAME" 2>/dev/null)
  for pair in "ssh:$NERD_SSH_PORT" "app:$NERD_APP_PORT"; do
    what=${pair%%:*} p=${pair#*:} WHAT=$(echo "${pair%%:*}" | tr a-z A-Z)
    if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
      row MISSING "port-$what" "'$p' is not a port" "fix NERD_${WHAT}_PORT in .env"
    elif grep -q ":$p\$" <<< "$ours"; then
      row OK "port-$what" "$p (published by the running $NERD_NAME)"
    elif nerd_port_busy "$p"; then
      row MISSING "port-$what" "$p is in use" "choose a free port: NERD_${WHAT}_PORT in .env (ss -ltnp shows who has it)"
    else
      row OK "port-$what" "$p free"
    fi
  done
fi

# --- ssh public key ---------------------------------------------------------------------------
if kf=$(nerd_keys_file) && [ -s "$kf" ]; then
  if grep -q '^\(ssh-\|ecdsa-\|sk-\)' "$kf"; then row OK ssh-key "$kf ($(grep -c . "$kf") key(s))"
  else row MISSING ssh-key "$kf is not a public key file" "point NERD_AUTHORIZED_KEYS_FILE at a .pub file"; fi
else
  row MISSING ssh-key "no public key (${NERD_AUTHORIZED_KEYS_FILE:-~/.ssh/id_*.pub})" "ssh-keygen -t ed25519, or copy the public key of the machine you will connect from and set NERD_AUTHORIZED_KEYS_FILE"
fi

# --- network (WARN only: an image already built and a model already fetched need none) -------
if [ $offline = 0 ] && command -v curl >/dev/null 2>&1; then
  for u in https://huggingface.co https://registry.npmjs.org https://registry-1.docker.io/v2/ https://github.com https://nodejs.org/dist/; do
    if curl -sS -o /dev/null -m 10 "$u" 2>/dev/null; then row OK net "$u reachable"
    else row WARN net "$u not reachable" "needed for the first build ($u) or the model download; behind a proxy set HTTPS_PROXY for docker too"; fi
  done
fi

echo
if [ $missing -gt 0 ]; then
  echo "$missing MISSING, $warn WARN. Fix the MISSING lines (tools/install-prerequisites.sh does most on Ubuntu/Debian), then run this again."
  exit 1
fi
echo "Nothing missing ($warn WARN). Next: cp env.example .env (optional), then ./UP"
exit 0
