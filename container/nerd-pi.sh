#!/bin/bash
# Pi in a container started in `hold` mode (entrypoint.sh): a session manager
# (agora's agora-host) runs it with docker exec and owns its life.
#
#   docker exec -it <c> nerd-pi tui [pi options...]   Pi's TUI in /workspace (--continue
#                                                     picks up the last session)
#   docker exec <c> nerd-pi run "<task>"              the headless run on the task; exit
#                                                     code as run.ts (0 done, 1 not done,
#                                                     2 bad arguments, 130/143 SIGINT/SIGTERM)
#
# docker exec gets the image's and the container's environment but not what the
# entrypoint exported, so the same settings are made here. NERD_AGORA_CHANNEL
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
health=${NERD_BASE_URL%/}; health=${health%/v1}/health
curl -sf -m 2 "$health" >/dev/null || say "no llama-server at $health yet; Pi's requests fail until it answers"
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
    [ -n "${1:-}" ] || { say 'no task: nerd-pi run "<task>"'; exit 2; }
    exec node /opt/nerd/agent/src/run.ts /workspace "$1" --log "/logs/events-$stamp.jsonl" ;;
  *)
    sed -n 4,9p "$0" >&2; exit 2 ;;
esac
