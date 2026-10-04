#!/bin/bash
# Entrypoint of the nerd image: make sure the model is in /models, start
# llama-server inside the container, wait for it, run the agent on the task
# in /workspace, stop the server when the agent exits.
#
#   docker run ... nerd "<task>"       the agent on the task (or NERD_TASK)
#   docker run ... nerd tui            Pi's interactive TUI in tmux, reached over ssh
#   docker run ... nerd serve          only llama-server, in the foreground
#   docker run ... nerd fetch          only download/verify the model
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
# Environment (all optional):
#   NERD_MODEL_VARIANT  q1 (Bonsai 2 PTQ1_0, 5.95 GB, default) | q2 (PQ2_0, 7.21 GB)
#   NERD_MODEL_FILE     a GGUF already in /models instead of a variant (no download)
#   NERD_CTX            context tokens (65536)        NERD_KV     KV cache type (q4_0)
#   NERD_NGL            layers on the GPU (99)        NERD_SLOTS  parallel slots (1)
#   NERD_LLAMA_ARGS     extra llama-server arguments, word-split
#   NERD_LLAMA_PORT     llama-server's port (8080; the older name NERD_PORT works too)
#   NERD_HOST           llama-server's address (127.0.0.1)
#   NERD_SSH_PORT       sshd's port in tui mode (2222)
#   NERD_HEALTH_TIMEOUT seconds to wait for the server (900)
#   HF_TOKEN            sent to Hugging Face if set
#   NERD_BASE_URL       llama-server outside the container, e.g.
#                       http://host.docker.internal:8080/v1 (macOS: the server
#                       runs on the host with Metal, tools/llama-host.sh). Then
#                       no model is downloaded and no server started here; the
#                       agent takes the model and context from that server.
#                       An image built with LLAMA=none needs it.
# plus the agent's own NERD_* variables (agent/src/run.ts). Logs: /logs.
set -uo pipefail

say() { echo "[nerd $(date +%H:%M:%S)] $*" >&2; }
die() { say "ERROR: $*"; exit 1; }

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

# tui mode: sshd first, so a missing key is reported at once and the operator
# can log in (to a shell) while the model is still downloading.
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
export HOME=${HOME:-/home/nerd}
mkdir -p /logs 2>/dev/null
[ "${1:-}" = tui ] && start_sshd

external=${NERD_BASE_URL:-}
if [ -n "$external" ]; then
  case "${1:-}" in serve|fetch) die "$1: NERD_BASE_URL is set, the server is outside this container ($external)" ;; esac
elif [ ! -s /opt/llama/REF ] || [ "$(cat /opt/llama/REF)" = none ]; then
  die "this image has no llama-server (built with LLAMA=none): set NERD_BASE_URL to a server outside it (docs/MACOS.md)"
fi

if [ -n "$external" ]; then
  :
elif [ -n "${NERD_MODEL_FILE:-}" ]; then
  model=/models/$NERD_MODEL_FILE
  [ -f "$model" ] || die "NERD_MODEL_FILE: $model not found"
else
  [ -w /models ] || die "/models is not writable by uid $(id -u) (mount a volume there)"
  fetch_model || exit 1
  model=/models/$file
fi
[ "${1:-}" = fetch ] && exit 0

port=${NERD_LLAMA_PORT:-${NERD_PORT:-8080}}; host=${NERD_HOST:-127.0.0.1}
# shellcheck disable=SC2206
server=(llama-server -m "${model:-}" $(nerd_server_args)
  --host "$host" --port "$port" ${NERD_LLAMA_ARGS:-})

if [ "${1:-}" = serve ]; then say "serving: ${server[*]}"; exec "${server[@]}"; fi

mode=task
if [ "${1:-}" = tui ]; then
  mode=tui
else
  task=${*:-${NERD_TASK:-}}
  [ -n "$task" ] || die 'no task: docker run ... nerd "<task>" (or NERD_TASK, or "tui", "serve", "fetch")'
fi

stamp=$(date +%Y%m%d-%H%M%S)
t0=$SECONDS
spid=""
stop_server() {
  [ -n "$spid" ] && kill -0 "$spid" 2>/dev/null || return 0
  kill "$spid"; for _ in $(seq 30); do kill -0 "$spid" 2>/dev/null || return 0; sleep 1; done
  kill -9 "$spid" 2>/dev/null
}
trap stop_server EXIT
trap 'exit 143' TERM INT

if [ -n "$external" ]; then
  # The server is someone else's to start; wait for it as for our own (it may
  # still be loading the model), and say where it is if it never answers.
  health=${external%/}; health=${health%/v1}/health
  say "llama-server outside the container: $external; waiting for $health"
  for _ in $(seq "${NERD_HEALTH_TIMEOUT:-900}"); do
    curl -sf -m 2 "$health" >/dev/null && break
    sleep 1
  done
  curl -sf -m 2 "$health" >/dev/null || die "no llama-server at $health (on macOS: tools/llama-host.sh start on the host; docs/MACOS.md)"
  say "llama-server at $external healthy after $((SECONDS - t0)) s"
  export NERD_BASE_URL=$external
else
  slog=/logs/server-$stamp.log
  say "starting llama-server (log $slog): ${server[*]}"
  "${server[@]}" > "$slog" 2>&1 &
  spid=$!
  for _ in $(seq "${NERD_HEALTH_TIMEOUT:-900}"); do
    kill -0 "$spid" 2>/dev/null || { tail -30 "$slog" >&2; die "llama-server exited during startup"; }
    curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null && break
    sleep 1
  done
  curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null || { tail -30 "$slog" >&2; die "llama-server not healthy"; }
  say "llama-server healthy in $((SECONDS - t0)) s"
  export NERD_BASE_URL="http://127.0.0.1:$port/v1"
fi

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
  # Up while sshd runs; if our llama-server dies, the container ends too. An
  # outside server going away is not ours to restart: Pi reports it and
  # retries, and works again when it is back.
  if [ -n "$spid" ]; then wait -n "$sshd_pid" "$spid"; else wait "$sshd_pid"; fi
  rc=$?
  say "sshd or llama-server exited ($rc)"
  tmux kill-server 2>/dev/null
  kill "$sshd_pid" 2>/dev/null
  exit "$rc"
fi

say "agent on /workspace (events /logs/events-$stamp.jsonl)"
node /opt/nerd/agent/src/run.ts /workspace "$task" --log "/logs/events-$stamp.jsonl"
rc=$?
say "agent exited $rc"
exit "$rc"
