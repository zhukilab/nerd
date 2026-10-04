#!/bin/bash
# Entrypoint of both nerd images (Dockerfile targets server and agent).
#
# The server image:
#   docker run ... nerd:server serve     download/verify the model into /models, run
#                                        llama-server in the foreground (the default)
#   docker run ... nerd:server fetch     only download/verify the model
# The agent image, against a server at NERD_BASE_URL (required):
#   docker run ... nerd:agent "<task>"   the agent on the task (or NERD_TASK), headless
#   docker run ... nerd:agent tui        Pi's interactive TUI in tmux, reached over ssh
#
# tui: sshd as user nerd on NERD_SSH_PORT (2222), key only (NERD_AUTHORIZED_KEYS,
# or a file mounted at /run/nerd/authorized_keys; host keys on the /ssh volume).
# A login attaches to tmux session "nerd" where Pi runs in /workspace; the
# sessions are kept in /logs/sessions. NERD_APP_PORT (8000) is the port the
# agent is told to serve what it builds on; NERD_OPERATOR_URL, if set, is the
# address the operator opens it at (http://<name the operator uses>:8000), told
# to the agent as a fact. Containers sharing one network namespace need
# different NERD_SSH_PORT, NERD_LLAMA_PORT and NERD_APP_PORT.
#
# Environment (all optional unless said):
#   server:
#   NERD_MODEL_VARIANT  q1 (Bonsai 2 PTQ1_0, 5.95 GB, default) | q2 (PQ2_0, 7.21 GB)
#   NERD_MODEL_FILE     a GGUF already in /models instead of a variant (no download)
#   NERD_CTX            context tokens (65536)        NERD_KV     KV cache type (q4_0)
#   NERD_NGL            layers on the GPU (99)        NERD_SLOTS  parallel slots (1)
#   NERD_LLAMA_ARGS     extra llama-server arguments, word-split
#   NERD_LLAMA_PORT     llama-server's port (8080; the older name NERD_PORT works too)
#   NERD_HOST           llama-server's address (the image sets 0.0.0.0)
#   HF_TOKEN            sent to Hugging Face if set
#   agent:
#   NERD_BASE_URL       the server, required: http://<server container>:8080/v1,
#                       or http://host.docker.internal:8080/v1 for one on the host
#                       (macOS, tools/llama-host.sh). The agent takes the model
#                       and its context from it.
#   NERD_SSH_PORT       sshd's port in tui mode (2222)
#   NERD_HEALTH_TIMEOUT seconds to wait for the server (task 900; tui 0 = no limit)
#   NERD_WEB            1 (default): SearXNG on loopback for web_search; 0: off
#   NERD_SEARXNG_PORT   its port (8888)
# plus the agent's own NERD_* variables (agent/src/run.ts). Logs: /logs.
set -uo pipefail

say() { echo "[nerd $(date +%H:%M:%S)] $*" >&2; }
die() { say "ERROR: $*"; exit 1; }

export HOME=${HOME:-/home/nerd}
mkdir -p /logs 2>/dev/null
role=agent
case "${1:-}" in serve|fetch) role=server ;; esac

# --- server --------------------------------------------------------------------
if [ "$role" = server ]; then
  [ -x /opt/llama/llama-server ] || die "$1: this is the agent image; the server image is built with --target server"
  # repo, file, size, sha of the variant; llama-server's arguments (model.sh).
  # shellcheck source=container/model.sh
  . "$(dirname "$0")/model.sh"
  nerd_model "${NERD_MODEL_VARIANT:-q1}" || die "NERD_MODEL_VARIANT must be q1 or q2, not '${NERD_MODEL_VARIANT}'"

  fetch_model() {
    local m=/models/$file part=/models/$file.part ok=/models/$file.sha256-ok
    # A file is trusted once its hash was checked; the marker records that, so
    # later starts do not re-hash 6-7 GB. Size is still checked every time.
    if [ -f "$m" ] && [ "$(stat -c %s "$m")" = "$size" ] && [ "$(cat "$ok" 2>/dev/null)" = "$sha" ]; then
      say "model present: $m"; return 0
    fi
    if [ -f "$m" ]; then mv "$m" "$part"; fi   # unverified: re-check it as a partial download
    local url="https://huggingface.co/$repo/resolve/main/$file" t0=$SECONDS have
    local -a auth=()
    [ -n "${HF_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $HF_TOKEN")
    have=$(stat -c %s "$part" 2>/dev/null || echo 0)
    if [ "$have" -gt "$size" ]; then rm -f "$part"; have=0; fi
    say "downloading $file ($size bytes; have $have) from $url"
    for attempt in $(seq 20); do
      [ "$have" = "$size" ] && break
      # -C - resumes from the partial file's size.
      curl -fL --retry 5 --retry-delay 5 --connect-timeout 30 -C - "${auth[@]}" -o "$part" "$url" \
        || say "curl exited $? (attempt $attempt), resuming"
      have=$(stat -c %s "$part" 2>/dev/null || echo 0)
      if [ "$have" -gt "$size" ]; then say "partial file larger than expected, restarting"; rm -f "$part"; have=0; fi
      [ "$have" = "$size" ] || sleep 5
    done
    [ "$have" = "$size" ] || die "download incomplete: $have of $size bytes"
    say "downloaded in $((SECONDS - t0)) s; checking sha256"
    local got; got=$(sha256sum "$part" | cut -d' ' -f1)
    if [ "$got" != "$sha" ]; then rm -f "$part"; die "sha256 mismatch: got $got, want $sha (file removed)"; fi
    mv "$part" "$m" && echo "$sha" > "$ok"
    say "model ready: $m ($((SECONDS - t0)) s with the hash check)"
  }

  if [ -n "${NERD_MODEL_FILE:-}" ]; then
    model=/models/$NERD_MODEL_FILE
    [ -f "$model" ] || die "NERD_MODEL_FILE: $model not found"
  else
    [ -w /models ] || die "/models is not writable by uid $(id -u) (mount a volume there)"
    fetch_model || exit 1
    model=/models/$file
  fi
  [ "$1" = fetch ] && exit 0
  port=${NERD_LLAMA_PORT:-${NERD_PORT:-8080}}
  # shellcheck disable=SC2206
  server=(llama-server -m "$model" $(nerd_server_args)
    --host "${NERD_HOST:-127.0.0.1}" --port "$port" ${NERD_LLAMA_ARGS:-})
  say "serving: ${server[*]}"
  exec "${server[@]}"
fi

# --- agent ---------------------------------------------------------------------
[ -d /opt/nerd/agent ] || die "this is the server image (serve, fetch); the agent is the image built without --target"
base=${NERD_BASE_URL:-}
[ -n "$base" ] || die "NERD_BASE_URL is not set: the agent needs a llama-server, e.g. http://nerd-llm:8080/v1 (./UP sets it; README, \"Running by hand\")"

# tui mode: sshd first, so a missing key is reported at once and the operator
# can log in (to a shell) while the server is still loading.
start_sshd() {
  local keys=/run/nerd/authorized_keys
  install -d -m 700 "$HOME/.ssh"
  if [ -n "${NERD_AUTHORIZED_KEYS:-}" ]; then
    printf '%s\n' "$NERD_AUTHORIZED_KEYS" > "$HOME/.ssh/authorized_keys"
  elif [ -s "$keys" ]; then
    cp "$keys" "$HOME/.ssh/authorized_keys"
  else
    die "tui: no public key: set NERD_AUTHORIZED_KEYS or mount a file at $keys"
  fi
  chmod 600 "$HOME/.ssh/authorized_keys"
  # Host keys on the /ssh volume, so the fingerprint survives a new container.
  local t
  for t in ed25519 rsa; do
    [ -f "/ssh/ssh_host_${t}_key" ] || ssh-keygen -q -t "$t" -N '' -f "/ssh/ssh_host_${t}_key" || die "cannot write /ssh"
    ssh-keygen -lf "/ssh/ssh_host_${t}_key.pub" >&2
  done
  # -p overrides the config's Port.
  /usr/sbin/sshd -D -e -f /opt/nerd/sshd_config -p "$ssh_port" 2>> /logs/sshd.log &
  sshd_pid=$!
  sleep 1
  kill -0 "$sshd_pid" 2>/dev/null || { tail -20 /logs/sshd.log >&2; die "sshd did not start"; }
  say "sshd on port $ssh_port (log /logs/sshd.log); user nerd, key only"
}
ssh_port=${NERD_SSH_PORT:-2222}

# SearXNG for web_search (ticket 041), on loopback in this container, unless
# NERD_WEB=0. Not fatal: without it web_search reports an error and the agent
# still works; the log says why.
start_searxng() {
  [ "${NERD_WEB:-1}" = 0 ] && return 0
  [ -x /opt/searxng/venv/bin/python ] || return 0
  local port=${NERD_SEARXNG_PORT:-8888}
  SEARXNG_SETTINGS_PATH=/opt/searxng/settings.yml SEARXNG_PORT=$port SEARXNG_BIND_ADDRESS=127.0.0.1 \
    SEARXNG_SECRET=$(head -c 24 /dev/urandom | base64) PYTHONPATH=/opt/searxng/src \
    /opt/searxng/venv/bin/python -m searx.webapp > /logs/searxng.log 2>&1 &
  export SEARXNG_URL=http://127.0.0.1:$port WEB_SEARCH_PROVIDER=searxng
  for _ in $(seq 30); do
    curl -sf -m 2 "$SEARXNG_URL/healthz" >/dev/null && { say "SearXNG on $SEARXNG_URL (log /logs/searxng.log)"; return 0; }
    sleep 1
  done
  say "SearXNG did not answer on $SEARXNG_URL in 30 s; web_search will fail (/logs/searxng.log)"
}

mode=task
if [ "${1:-}" = tui ]; then
  mode=tui
  start_sshd
else
  task=${*:-${NERD_TASK:-}}
  [ -n "$task" ] || die 'no task: docker run ... nerd:agent "<task>" (or NERD_TASK, or "tui")'
fi
start_searxng

# The server is another container's (or the host's) to start: wait for it as
# long as it may take to download and load the model, and say where it is if
# it never answers.
stamp=$(date +%Y%m%d-%H%M%S)
t0=$SECONDS
health=${base%/}; health=${health%/v1}/health
# tui waits as long as it takes (sshd is up meanwhile; a first start downloads
# 6-7 GB); a headless task gives up after NERD_HEALTH_TIMEOUT.
limit=${NERD_HEALTH_TIMEOUT:-}
[ -z "$limit" ] && { [ "$mode" = tui ] && limit=0 || limit=900; }
say "llama-server: $base; waiting for $health$([ "$limit" = 0 ] || echo " (up to $limit s)")"
until curl -sf -m 2 "$health" >/dev/null; do
  waited=$((SECONDS - t0))
  [ "$limit" != 0 ] && [ "$waited" -ge "$limit" ] && die "no llama-server at $health after $waited s (./STATUS; on macOS: tools/llama-host.sh start)"
  [ $((waited % 60)) -lt 2 ] && [ "$waited" -ge 60 ] && say "still waiting for $health ($waited s)"
  sleep 2
done
say "llama-server healthy after $((SECONDS - t0)) s"
export NERD_BASE_URL=$base

if [ "$mode" = tui ]; then
  # Pi's TUI in tmux session "nerd"; it restarts with --continue if it exits,
  # so /quit or a crash comes back to the same conversation. The tmux server
  # inherits this environment (NERD_*, PATH).
  export NERD_SESSION_DIR=${NERD_SESSION_DIR:-/logs/sessions} NERD_APP_PORT=${NERD_APP_PORT:-8000}
  export NERD_VERIFY_LOG=${NERD_VERIFY_LOG:-/logs/verifier-$stamp.jsonl}
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  tmux -u new-session -d -s nerd -n pi -c /workspace \
    "while :; do node /opt/nerd/agent/src/tui.ts /workspace --continue; echo '[pi exited; restarting in 3 s]'; sleep 3; done" \
    || die "tmux session did not start"
  say "Pi in tmux session 'nerd'; ssh -p $ssh_port nerd@<host> attaches to it"
  # Up while sshd runs. The server going away is not this container's to
  # restart: Pi reports the failed request and retries, and works again when
  # the server is back.
  trap 'exit 143' TERM INT
  wait "$sshd_pid"
  rc=$?
  say "sshd exited ($rc)"
  tmux kill-server 2>/dev/null
  exit "$rc"
fi

say "agent on /workspace (events /logs/events-$stamp.jsonl)"
node /opt/nerd/agent/src/run.ts /workspace "$task" --log "/logs/events-$stamp.jsonl"
rc=$?
say "agent exited $rc"
exit "$rc"
