#!/bin/bash
# Pi in a container started in `hold` mode (entrypoint.sh): a session manager
# (agora's agora-host) runs it with docker exec and owns its life.
#
#   docker exec -it <c> nerd-pi tui [pi options...]   Pi's TUI in /workspace (--continue
#                                                     picks up the last session)
#   docker exec <c> nerd-pi run "<task>"              the headless run on the task; exit
#                                                     code as run.ts (0 done, 1 not done,
#                                                     2 bad arguments, 75 paused, 130/143 SIGINT/SIGTERM)
#   docker exec <c> nerd-pi run --task-file <path>    the same, the task read from a file (no argv
#                                                     word limit; read at the start, see run-args.ts)
#
# docker exec gets the image's and the container's environment but not what the
# entrypoint exported, so the same settings are made here. AGORA_PI_CHANNEL
# (the channel socket in the container) is the container's to set.
# Without a model server Pi still starts if NERD_MODEL and NERD_CTX are set
# (it shows its screen, and every request fails); otherwise it needs /v1/models.
set -uo pipefail

say() { echo "[nerd-pi $(date +%H:%M:%S)] $*" >&2; }

export HOME=${HOME:-/home/nerd} LANG=C.UTF-8 LC_ALL=C.UTF-8
export NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE:-$HOME/.cache/node-compile-cache}
[ -n "${NERD_BASE_URL:-}" ] || { say "NERD_BASE_URL is not set (the container's environment)"; exit 2; }
# SearXNG, started by the entrypoint on loopback unless NERD_WEB=0.
if [ "${NERD_WEB:-1}" != 0 ] && [ -x /opt/searxng/venv/bin/python ]; then
  export SEARXNG_URL=http://127.0.0.1:${NERD_SEARXNG_PORT:-8888} WEB_SEARCH_PROVIDER=searxng
fi
root=${NERD_BASE_URL%/}; root=${root%/v1}
# llama-server's /health, or Ollama's /api/version (Ollama has no /health).
curl -sf -m 2 "$root/health" >/dev/null || curl -sf -m 2 "$root/api/version" >/dev/null \
  || say "no model server at $root yet; Pi's requests fail until it answers"
stamp=$(date +%Y%m%d-%H%M%S)
cd /workspace || exit 1

case "${1:-}" in
  tui)
    shift
    export NERD_SESSION_DIR=${NERD_SESSION_DIR:-/logs/sessions} NERD_APP_PORT=${NERD_APP_PORT:-8000}
    export NERD_VERIFY_LOG=${NERD_VERIFY_LOG:-/logs/verifier-$stamp.jsonl}
    exec node /opt/nerd/agent/src/tui.ts /workspace "$@" ;;
  run)
    shift
    if [ -z "${1:-}" ]; then
      # No task here: run.ts takes NERD_PROBLEM_FILE (relative to /workspace), or with NERD_MODE=ralph
      # a PLAN.md, or with NERD_RALPH_RESUME=1 the paused run's saved task, also from the settings
      # file; with none of them it prints the usage and exits 2.
      exec node /opt/nerd/agent/src/run.ts /workspace --log "/logs/events-$stamp.jsonl"
    fi
    if [ "$1" = --task-file ]; then
      [ -n "${2:-}" ] || { say 'no path: nerd-pi run --task-file <path>'; exit 2; }
      exec node /opt/nerd/agent/src/run.ts /workspace --task-file "$2" --log "/logs/events-$stamp.jsonl"
    fi
    exec node /opt/nerd/agent/src/run.ts /workspace "$1" --log "/logs/events-$stamp.jsonl" ;;
  *)
    sed -n 4,11p "$0" >&2; exit 2 ;;
esac
