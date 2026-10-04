#!/usr/bin/env bash
# llama-server on the machine itself, not in the container: for macOS on Apple
# silicon, where docker cannot reach the GPU but llama.cpp runs on it through
# Metal (docs/MACOS.md). The agent's container (./UP with NERD_LLAMA=host, the
# default on macOS) talks to this server. Same fork and tag as the image
# (read from the Dockerfile), same model files and checksums, same server
# arguments (container/model.sh).
#
#   tools/llama-host.sh build     clone the fork at the pinned tag, build llama-server
#   tools/llama-host.sh fetch     download the model (resumes), check its sha256
#   tools/llama-host.sh start     build and fetch if needed, start the server, wait for it
#   tools/llama-host.sh stop | status | logs
#
# Settings from .env (env.example): NERD_MODEL_VARIANT, NERD_CTX,
# NERD_LLAMA_PORT, and here only:
#   NERD_HOST_DIR     where the source, build, model and log go (~/.nerd)
#   NERD_LLAMA_HOST   address the server listens on (127.0.0.1)
#   NERD_LLAMA_ARGS   extra llama-server arguments, word-split
# Written for the bash macOS ships (3.2) as well.
set -euo pipefail
# shellcheck source=tools/lib.sh
. "$(dirname "$0")/lib.sh"
# shellcheck source=container/model.sh
. "$NERD_ROOT/container/model.sh"
nerd_load_env
nerd_settings

say() { echo "[llama-host] $*"; }
die() { echo "[llama-host] ERROR: $*" >&2; exit 1; }

dir=${NERD_HOST_DIR:-$HOME/.nerd}
dir=${dir/#\~/$HOME}
src=$dir/llama.cpp
bin=$src/build/bin/llama-server
models=$dir/models
log=$dir/llama-server.log
pidf=$dir/llama-server.pid
bind=${NERD_LLAMA_HOST:-127.0.0.1}
port=$NERD_LLAMA_PORT
nerd_model "$NERD_MODEL_VARIANT" || die "NERD_MODEL_VARIANT must be q1 or q2, not '$NERD_MODEL_VARIANT'"
model=$models/$file

# The fork and tag the image builds (Dockerfile ARG lines): one place to change.
dockerfile_arg() { sed -n "s/^ARG $1=//p" "$NERD_ROOT/Dockerfile" | head -1; }
repo_url=$(dockerfile_arg LLAMA_REPO)
ref=$(dockerfile_arg LLAMA_REF)
[ -n "$repo_url" ] && [ -n "$ref" ] || die "cannot read LLAMA_REPO/LLAMA_REF from $NERD_ROOT/Dockerfile"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
bytes() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }
up() { curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; }
running_pid() { [ -s "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && cat "$pidf"; }

build() {
  for t in git cmake curl; do
    command -v "$t" >/dev/null 2>&1 || die "$t not found (macOS: brew install $t; the compiler: xcode-select --install)"
  done
  command -v c++ >/dev/null 2>&1 || die "no C++ compiler (macOS: xcode-select --install)"
  mkdir -p "$dir"
  if [ -x "$bin" ] && [ "$(cat "$src/REF" 2>/dev/null)" = "$ref" ]; then
    say "llama-server $ref already built: $bin"; return 0
  fi
  rm -rf "$src"
  say "cloning $repo_url at $ref"
  git clone -q --depth 1 -b "$ref" "$repo_url" "$src"
  # Metal is on by default on macOS (the shaders embedded in the binary).
  # GGML_NATIVE: this machine's CPU, it is built where it runs.
  say "building llama-server (a few minutes)"
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF >/dev/null
  ncpu=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
  cmake --build "$src/build" -j "$ncpu" --target llama-server >/dev/null
  [ -x "$bin" ] || die "build finished without $bin"
  echo "$ref" > "$src/REF"
  say "built: $bin"
}

fetch() {
  local part=$model.part ok=$model.sha256-ok have url t0=$SECONDS
  mkdir -p "$models"
  if [ "$(bytes "$model")" = "$size" ] && [ "$(cat "$ok" 2>/dev/null)" = "$sha" ]; then
    say "model present: $model"; return 0
  fi
  [ -f "$model" ] && mv "$model" "$part"   # unverified: re-check it as a partial download
  have=$(bytes "$part")
  [ "$have" -gt "$size" ] && { rm -f "$part"; have=0; }
  url="https://huggingface.co/$repo/resolve/main/$file"
  say "downloading $file ($size bytes; have $have) from $url"
  for attempt in $(seq 20); do
    [ "$have" = "$size" ] && break
    if [ -n "${HF_TOKEN:-}" ]; then
      curl -fL --retry 5 --retry-delay 5 --connect-timeout 30 -C - -H "Authorization: Bearer $HF_TOKEN" -o "$part" "$url" || say "curl exited $? (attempt $attempt), resuming"
    else
      curl -fL --retry 5 --retry-delay 5 --connect-timeout 30 -C - -o "$part" "$url" || say "curl exited $? (attempt $attempt), resuming"
    fi
    have=$(bytes "$part")
    [ "$have" -gt "$size" ] && { say "partial file larger than expected, restarting"; rm -f "$part"; have=0; }
    [ "$have" = "$size" ] || sleep 5
  done
  [ "$have" = "$size" ] || die "download incomplete: $have of $size bytes"
  say "downloaded in $((SECONDS - t0)) s; checking sha256"
  got=$(sha256 "$part")
  [ "$got" = "$sha" ] || { rm -f "$part"; die "sha256 mismatch: got $got, want $sha (file removed)"; }
  mv "$part" "$model" && echo "$sha" > "$ok"
  say "model ready: $model"
}

start() {
  if pid=$(running_pid); then say "already running (pid $pid); tools/llama-host.sh stop first to restart"; return 0; fi
  up && die "something else answers on 127.0.0.1:$port; choose another NERD_LLAMA_PORT in .env"
  build
  fetch
  # shellcheck disable=SC2046,SC2086
  set -- "$bin" -m "$model" $(nerd_server_args) --host "$bind" --port "$port" ${NERD_LLAMA_ARGS:-}
  say "starting: $* (log $log)"
  nohup "$@" > "$log" 2>&1 &
  echo $! > "$pidf"
  for _ in $(seq 600); do
    kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -30 "$log" >&2; die "llama-server exited during startup (log above; out of memory? NERD_CTX=32768 in .env)"; }
    up && { say "serving on $bind:$port, pid $(cat "$pidf"); next: ./UP"; return 0; }
    sleep 1
  done
  tail -30 "$log" >&2; die "llama-server not healthy after 600 s"
}

stop() {
  if pid=$(running_pid); then
    kill "$pid"
    for _ in $(seq 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
    say "stopped (pid $pid)"
  else
    say "not running"
  fi
  rm -f "$pidf"
}

status() {
  if pid=$(running_pid) && up; then
    m=$(curl -sf -m 3 "http://127.0.0.1:$port/v1/models" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    say "serving on $bind:$port, pid $pid, model ${m:-?}"
  elif pid=$(running_pid); then
    say "pid $pid runs, /health does not answer yet (loading?): tools/llama-host.sh logs"; return 1
  else
    say "not running"; return 1
  fi
}

case "${1:-}" in
  build) build ;;
  fetch) fetch ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 50 -f "$log" ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
