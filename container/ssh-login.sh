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
# Logged in while the agent is still starting (the model server loads, or the
# model downloads on the first start): wait for Pi's session, Ctrl-C for a shell.
if [ -f /tmp/nerd-tui-starting ] && ! tmux has-session -t nerd 2>/dev/null; then
  echo "The agent starts when the model server is ready (the first start downloads the model: minutes)."
  echo "Waiting for it; Ctrl-C gives a shell instead."
  trap 'echo; exec /bin/bash -l' INT
  while [ -f /tmp/nerd-tui-starting ] && ! tmux has-session -t nerd 2>/dev/null; do sleep 2; printf .; done
  trap - INT
  echo
fi
if tmux has-session -t nerd 2>/dev/null; then
  exec tmux -u attach-session -t nerd
fi
echo "no tmux session 'nerd' (is the container in tui mode?); a shell instead" >&2
exec /bin/bash -l
