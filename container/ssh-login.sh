#!/bin/bash
# ForceCommand of the container's sshd: an interactive login attaches to the
# tmux session "nerd" in which Pi runs; a command given to ssh runs as it is
# (ssh -p 2222 nerd@host tmux capture-pane -p -t nerd).
export LANG=C.UTF-8 LC_ALL=C.UTF-8
# The same as the image's PATH (Dockerfile): languages in the home first.
export PATH=/home/nerd/.local/bin:/home/nerd/.cargo/bin:/home/nerd/go/bin:/home/nerd/.local/go/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_HOME=/home/nerd/.cargo RUSTUP_HOME=/home/nerd/.rustup GOPATH=/home/nerd/go GOMODCACHE=/home/nerd/.cache/go-mod \
  GOCACHE=/home/nerd/.cache/go-build UV_CACHE_DIR=/home/nerd/.cache/uv PIP_CACHE_DIR=/home/nerd/.cache/pip \
  npm_config_cache=/home/nerd/.cache/npm NPM_CONFIG_PREFIX=/home/nerd/.local
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi
if tmux has-session -t nerd 2>/dev/null; then
  exec tmux -u attach-session -t nerd
fi
echo "no tmux session 'nerd' (is the container in tui mode?); a shell instead" >&2
exec /bin/bash -l
