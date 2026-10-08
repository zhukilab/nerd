#!/usr/bin/env bash
# The model server on a Mac with Apple silicon in Apple's own format, MLX:
# mlx-vlm's OpenAI-compatible server (NERD_LLAMA=mlx; docs/MACOS.md), where
# NERD_LLAMA=host runs llama-server. The agent's container reaches it the same
# way (host.docker.internal:NERD_LLAMA_PORT). Bonsai 2's MLX pack needs
# mlx-vlm's own loader for it (model_type prism_hadamard_qwen35): mlx-lm's
# server loads it without an error and answers garbage.
#
#   tools/mlx-host.sh python     the Python the venv is made with (3.12 or 3.13)
#   tools/mlx-host.sh install    a venv with mlx, mlx-vlm and everything they need at
#                                pinned versions and sha256 (tools/mlx-requirements.txt)
#   tools/mlx-host.sh fetch      download the model at its pinned revision, check its files
#   tools/mlx-host.sh start      install and fetch if needed, start the server, wait for
#                                it; one running with other settings is restarted
#   tools/mlx-host.sh stop | status | logs      (./DOWN runs stop too)
#
# Settings from .env (env.example): NERD_LLAMA_PORT, NERD_HOST_DIR (~/.nerd),
# NERD_LLAMA_HOST (127.0.0.1), HF_TOKEN, and here only:
#   NERD_MLX_MODEL    <owner>/<repo>[@<revision>] on Hugging Face, or the path of a
#                     directory with an MLX model (default: Bonsai 2 27B, 2-bit, at a
#                     pinned revision); e.g. mlx-community/Qwen3.5-2B-4bit to try quickly
#   NERD_MLX_PYTHON   the python3.12/3.13 to make the venv with (default: the first found)
#   NERD_MLX_ARGS     extra mlx_vlm.server arguments, word-split
#   NERD_REBUILD=1    make the venv again and restart the server even when nothing
#                     changed (./UP --rebuild sets it)
# Written for the bash macOS ships (3.2) as well.
set -euo pipefail
# shellcheck source=tools/lib.sh
. "$(dirname "$0")/lib.sh"
nerd_load_env
nerd_settings

say() { echo "[mlx-host] $*"; }
die() { echo "[mlx-host] ERROR: $*" >&2; exit 1; }

# Bonsai 2 27B, ternary, in MLX 2-bit (8.6 GB) at a fixed revision, and the
# sha256 of its files.json (every file's size and sha256), so a changed
# upstream pack is noticed rather than used.
DEFAULT_MODEL=prism-ml/Ternary-Bonsai-2-27B-mlx-2bit@fcba37d2117a7077eac6b613b2668d14d9779edd
DEFAULT_FILES_SHA=f0d3b0108d8e52685b81da7916e9943ff9cf2f470fbcc6b24f66a3d562492f1c

dir=${NERD_HOST_DIR:-$HOME/.nerd}
dir=${dir/#\~/$HOME}
venv=$dir/mlx-venv
reqs=${NERD_MLX_REQUIREMENTS:-$NERD_ROOT/tools/mlx-requirements.txt}   # another file: for tests only
log=$dir/mlx-server.log
pidf=$dir/mlx-server.pid
argsf=$dir/mlx-server.args
bind=${NERD_LLAMA_HOST:-127.0.0.1}
port=$NERD_LLAMA_PORT
spec=${NERD_MLX_MODEL:-$DEFAULT_MODEL}
case "$spec" in
  /*|"~"*) mdir=${spec/#\~/$HOME} repo="" rev="" ;;   # a directory: used as it is
  */*) repo=${spec%@*} rev=main
       case "$spec" in *@*) rev=${spec##*@} ;; esac
       mdir=$dir/mlx-models/${repo/\//--}@$rev ;;
  *) die "NERD_MLX_MODEL=$spec: expected <owner>/<repo>[@<revision>] or a directory path" ;;
esac

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
up() { curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; }
running_pid() { [ -s "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && cat "$pidf"; }

# MLX runs on Apple silicon (Metal). NERD_MLX_ANY_OS=1 lets the scripts run
# elsewhere, for tests (mlx has a slow CPU build for Linux).
apple_only() {
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] && return 0
  [ "${NERD_MLX_ANY_OS:-}" = 1 ] && return 0
  die "MLX runs on a Mac with Apple silicon only; elsewhere: NERD_LLAMA=container"
}

# The interpreter for the venv: the pinned wheels are for CPython 3.12 and 3.13.
python_for_venv() {
  local p v
  for p in ${NERD_MLX_PYTHON:-} python3.13 python3.12 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 python3; do
    command -v "$p" >/dev/null 2>&1 || continue
    v=$("$p" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) || continue
    case "$v" in 3.12|3.13) command -v "$p"; return 0 ;; esac
  done
  return 1
}

install() {
  local py stamp
  apple_only
  stamp=$(sha256 "$reqs")
  if [ -x "$venv/bin/python" ] && [ "$(cat "$venv/REQS" 2>/dev/null)" = "$stamp" ] && [ "${NERD_REBUILD:-0}" != 1 ]; then
    say "mlx-vlm already installed: $venv"; return 0
  fi
  py=$(python_for_venv) || die "no Python 3.12 or 3.13: brew install python@3.13 (or set NERD_MLX_PYTHON in .env)"
  mkdir -p "$dir"
  rm -rf "$venv"
  say "making $venv with $py ($("$py" --version 2>&1))"
  "$py" -m venv "$venv"
  # Only wheels, only the pinned ones: --require-hashes refuses anything else.
  say "installing mlx, mlx-vlm and their dependencies (about 120 MB; the whole output goes to the log)"
  "$venv/bin/python" -m pip install --disable-pip-version-check --no-input --only-binary=:all: \
    --require-hashes -r "$reqs" >> "$dir/mlx-install.log" 2>&1 \
    || { tail -20 "$dir/mlx-install.log"; cat "$dir/mlx-install.log" >> "${NERD_LOG:-/dev/null}"; die "pip install failed (whole output in the log)"; }
  "$venv/bin/python" -c "from mlx_vlm.models.prism_hadamard_qwen35 import Model" \
    || die "the installed mlx-vlm has no Bonsai 2 loader (prism_hadamard_qwen35)"
  echo "$stamp" > "$venv/REQS"
  say "installed: $("$venv/bin/python" -c 'import mlx.core as mx, mlx_vlm; print("mlx", mx.__version__, "mlx-vlm", mlx_vlm.__version__)')"
}

fetch() {
  local t0=$SECONDS rc=0
  if [ -z "$repo" ]; then
    [ -d "$mdir" ] || die "NERD_MLX_MODEL: $mdir is not a directory"
    say "model (a directory, used as it is): $mdir"; return 0
  fi
  if [ -f "$mdir/.nerd-checked" ]; then say "model present: $mdir"; return 0; fi
  install
  mkdir -p "$dir/mlx-models"
  say "downloading $repo at $rev into $mdir.part (resumes; Bonsai 2 is 8.6 GB)"
  # hf comes with huggingface_hub in the venv; it reads HF_TOKEN itself.
  HF_HUB_DISABLE_TELEMETRY=1 "$venv/bin/hf" download "$repo" --revision "$rev" --local-dir "$mdir.part" \
    || die "download of $repo@$rev failed (run start again to resume; a gated repo needs HF_TOKEN)"
  say "downloaded in $((SECONDS - t0)) s; checking the files"
  if [ "$spec" = "$DEFAULT_MODEL" ]; then
    [ "$(sha256 "$mdir.part/files.json")" = "$DEFAULT_FILES_SHA" ] || die "files.json of $repo@$rev is not the pinned one"
  fi
  "$venv/bin/python" "$NERD_ROOT/tools/mlx-verify.py" "$mdir.part" > "$dir/mlx-verify.log" 2>&1 || rc=$?
  case "$rc" in
    0) say "every file matches files.json" ;;
    2) [ "$spec" = "$DEFAULT_MODEL" ] && die "the pinned model has no files.json"
       say "no files.json in $repo: the files are as Hugging Face sent them at $rev, not checked further" ;;
    *) tail -3 "$dir/mlx-verify.log"; die "a file of $repo@$rev does not match files.json (above; $dir/mlx-verify.log)" ;;
  esac
  rm -rf "$mdir"
  mv "$mdir.part" "$mdir" && date > "$mdir/.nerd-checked"
  say "model ready: $mdir"
}

start() {
  # The model is named by its directory: that is the id the server reports
  # (/health loaded_model) and the agent sends back.
  # shellcheck disable=SC2086
  set -- "$venv/bin/python" -m mlx_vlm.server --model "$mdir" --host "$bind" --port "$port" ${NERD_MLX_ARGS:-}
  if pid=$(running_pid); then
    if [ "$(cat "$argsf" 2>/dev/null)" = "$*" ] && [ "${NERD_REBUILD:-0}" != 1 ]; then say "already running with these settings (pid $pid)"; return 0; fi
    say "running with other settings (pid $pid), restarting; was: $(cat "$argsf" 2>/dev/null || echo unknown)"
    stop
  fi
  up && die "something else answers on 127.0.0.1:$port; choose another NERD_LLAMA_PORT in .env"
  install
  fetch
  say "starting: $* (log $log)"
  HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 nohup "$@" > "$log" 2>&1 &
  echo $! > "$pidf"
  echo "$*" > "$argsf"
  for _ in $(seq 900); do
    kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -30 "$log" >&2; die "the server exited during startup (log above; out of memory? a smaller NERD_CTX, or close other apps)"; }
    up && { say "serving on $bind:$port, pid $(cat "$pidf")"; return 0; }
    sleep 1
  done
  tail -30 "$log" >&2; die "the server did not answer /health after 900 s"
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
  local m
  if pid=$(running_pid) && up; then
    m=$(curl -sf -m 3 "http://127.0.0.1:$port/health" | grep -o '"loaded_model":"[^"]*"' | cut -d'"' -f4)
    say "serving on $bind:$port, pid $pid, model ${m:-?}"
  elif pid=$(running_pid); then
    say "pid $pid runs, /health does not answer yet (loading?): tools/mlx-host.sh logs"; return 1
  else
    say "not running"; return 1
  fi
}

case "${1:-}" in install|fetch|start) nerd_log "mlx-host-$1"; trap nerd_log_path EXIT ;; esac
case "${1:-}" in
  python) python_for_venv || die "no Python 3.12 or 3.13" ;;
  install) install ;;
  fetch) fetch ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 50 -f "$log" ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac
