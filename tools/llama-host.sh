#!/usr/bin/env bash
# llama-server on the machine itself, not in the container: for macOS on Apple
# silicon, where docker cannot reach the GPU but llama.cpp runs on it through
# Metal (docs/MACOS.md). The agent's container (./UP with NERD_LLAMA=host, the
# default on macOS) talks to this server. Same fork and tag as the image
# (read from the Dockerfile), same model files and checksums, same server
# arguments (container/model.sh).
#
#   tools/llama-host.sh check     the compiler and SDK can build C++ (seconds, nothing cloned)
#   tools/llama-host.sh build     clone the fork at the pinned tag, build llama-server
#   tools/llama-host.sh fetch     download the model (resumes), check its sha256
#   tools/llama-host.sh start     build and fetch if needed, start the server, wait for it;
#                                 one running with other settings is restarted
#   tools/llama-host.sh stop | status | logs      (./DOWN runs stop too)
#
# Settings from .env (env.example): NERD_MODEL_VARIANT or NERD_MODEL_GGUF
# (container/model.sh), NERD_CTX, NERD_LLAMA_PORT, and here only:
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
argsf=$dir/llama-server.args
bind=${NERD_LLAMA_HOST:-127.0.0.1}
port=$NERD_LLAMA_PORT
msg=$(nerd_model_select) || die "$msg"
nerd_model_select
model=$models/$name

# The fork and tag the image builds (Dockerfile ARG lines): one place to change.
dockerfile_arg() { sed -n "s/^ARG $1=//p" "$NERD_ROOT/Dockerfile" | head -1; }
repo_url=$(dockerfile_arg LLAMA_REPO)
ref=$(dockerfile_arg LLAMA_REF)
[ -n "$repo_url" ] && [ -n "$ref" ] || die "cannot read LLAMA_REPO/LLAMA_REF from $NERD_ROOT/Dockerfile"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
bytes() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }
up() { curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; }
running_pid() { [ -s "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && cat "$pidf"; }

# The compilers to build with. On macOS the Command Line Tools' clang and its
# SDK, by xcrun: a `c++` first in PATH from Homebrew's llvm, gcc or conda finds
# no C++ standard headers without the SDK ("fatal error: 'cstddef' file not
# found", the first report from a Mac, 2026-10-05).
compilers() {
  cc=${CC:-cc} cxx=${CXX:-c++} sdk="" cmake_os=()
  if [ "$(uname -s)" = Darwin ]; then
    sdk=$(xcrun --show-sdk-path 2>/dev/null) || die "no macOS SDK: xcode-select --install (or, if installed: sudo xcode-select --reset)"
    cc=$(xcrun -f clang) cxx=$(xcrun -f clang++)
    cmake_os=(-DCMAKE_OSX_SYSROOT="$sdk")
  fi
  command -v "$cxx" >/dev/null 2>&1 || die "no C++ compiler (macOS: xcode-select --install)"
  # A C++ file with standard headers must compile before a long build is tried.
  local t sys=()
  [ -n "$sdk" ] && sys=(-isysroot "$sdk")
  t=$(mktemp -d "${TMPDIR:-/tmp}/llama-host.XXXXXX")
  printf '#include <cstddef>\n#include <array>\n#include <mutex>\nint main() { std::array<int, 1> a{}; return (int)a.size() - 1; }\n' > "$t/probe.cpp"
  if ! "$cxx" -std=c++17 ${sys[@]+"${sys[@]}"} "$t/probe.cpp" -o "$t/probe" 2> "$t/err"; then
    cat "$t/err"; rm -rf "$t"
    die "the C++ compiler ($cxx) cannot build a file with standard headers. macOS: \`which -a c++ clang++\` (Homebrew llvm/gcc or conda first in PATH?); if it is Apple's: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
  fi
  rm -rf "$t"
  say "compilers: $cc, $cxx${sdk:+ (SDK $sdk)}"
}

build() {
  for t in git cmake curl; do
    command -v "$t" >/dev/null 2>&1 || die "$t not found (macOS: brew install $t; the compiler: xcode-select --install)"
  done
  mkdir -p "$dir"
  if [ -x "$bin" ] && [ "$(cat "$src/REF" 2>/dev/null)" = "$ref" ]; then
    say "llama-server $ref already built: $bin"; return 0
  fi
  compilers
  rm -rf "$src"
  say "cloning $repo_url at $ref"
  git -c advice.detachedHead=false clone -q --depth 1 -b "$ref" "$repo_url" "$src"
  # Metal is on by default on macOS (the shaders embedded in the binary).
  # GGML_NATIVE: this machine's CPU, it is built where it runs. The full
  # output goes to the log (nerd_log), only the last lines to the screen.
  say "building llama-server (a few minutes)"
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_COMPILER="$cc" -DCMAKE_CXX_COMPILER="$cxx" ${cmake_os[@]+"${cmake_os[@]}"} \
    > "$dir/cmake.log" 2>&1 || { tail -30 "$dir/cmake.log"; cat "$dir/cmake.log" >> "${NERD_LOG:-/dev/null}"; die "cmake configure failed (whole output in the log)"; }
  ncpu=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
  cmake --build "$src/build" -j "$ncpu" --target llama-server >> "$dir/cmake.log" 2>&1 \
    || { tail -30 "$dir/cmake.log"; cat "$dir/cmake.log" >> "${NERD_LOG:-/dev/null}"; die "build failed (whole output in the log)"; }
  [ -x "$bin" ] || die "build finished without $bin"
  echo "$ref" > "$src/REF"
  say "built: $bin"
}

fetch() {
  local part=$model.part ok=$model.sha256-ok have url t0=$SECONDS msize msha
  mkdir -p "$models"
  if [ "$as_is" = 1 ]; then
    [ -f "$model" ] || die "NERD_MODEL_GGUF: $model not found (put the file there, or use hf:<owner>/<repo>/<file>)"
    say "model (as it is, not checked): $model"; return 0
  fi
  # An unpinned hf: file (NERD_MODEL_GGUF) is checked against what Hugging
  # Face published at its first download, kept next to the marker.
  if [ -z "$size" ] && [ -s "$ok.meta" ]; then read -r msize msha < "$ok.meta"; size=$msize; sha=${sha:-$msha}; fi
  if [ -n "$size" ] && [ "$(bytes "$model")" = "$size" ] && [ "$(cat "$ok" 2>/dev/null)" = "$sha" ]; then
    say "model present: $model"; return 0
  fi
  if [ -z "$size" ] || [ -z "$sha" ]; then
    nerd_hf_meta || die "no size and sha256 for $repo/$file@$rev from Hugging Face (a wrong path, a gated repo without HF_TOKEN?)"
    echo "$size $sha" > "$ok.meta"
  fi
  [ -f "$model" ] && mv "$model" "$part"   # unverified: re-check it as a partial download
  have=$(bytes "$part")
  [ "$have" -gt "$size" ] && { rm -f "$part"; have=0; }
  url="https://huggingface.co/$repo/resolve/$rev/$file"
  say "downloading $name ($size bytes; have $have) from $url"
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
  # shellcheck disable=SC2046,SC2086
  set -- "$bin" -m "$model" $(nerd_server_args) --host "$bind" --port "$port" ${NERD_LLAMA_ARGS:-}
  # A server started with other settings (a variant or context changed in
  # .env) is restarted, as ./UP replaces a server container whose settings changed.
  if pid=$(running_pid); then
    if [ "$(cat "$argsf" 2>/dev/null)" = "$*" ]; then say "already running with these settings (pid $pid)"; return 0; fi
    say "running with other settings (pid $pid), restarting; was: $(cat "$argsf" 2>/dev/null || echo unknown)"
    stop
  fi
  up && die "something else answers on 127.0.0.1:$port; choose another NERD_LLAMA_PORT in .env"
  build
  fetch
  say "starting: $* (log $log)"
  nohup "$@" > "$log" 2>&1 &
  echo $! > "$pidf"
  echo "$*" > "$argsf"
  for _ in $(seq 600); do
    kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -30 "$log" >&2; die "llama-server exited during startup (log above; out of memory? NERD_CTX=32768 in .env)"; }
    up && { say "serving on $bind:$port, pid $(cat "$pidf")"; return 0; }
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
  rm -f "$pidf" "$argsf"
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

case "${1:-}" in build|fetch|start|check) nerd_log "llama-host-$1"; trap nerd_log_path EXIT ;; esac
case "${1:-}" in
  check) compilers; say "ok: llama-server can be built here (tools/llama-host.sh build)" ;;
  build) build ;;
  fetch) fetch ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 50 -f "$log" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
