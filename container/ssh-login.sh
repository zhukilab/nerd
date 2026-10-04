#!/bin/bash
# ForceCommand of the container's sshd: an interactive login attaches to the
# tmux session "nerd" in which Pi runs; a command given to ssh runs as it is
# (ssh -p 2222 nerd@host tmux capture-pane -p -t nerd).
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export PATH=/opt/node/bin:/opt/llama:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi
if tmux has-session -t nerd 2>/dev/null; then
  exec tmux -u attach-session -t nerd
fi
echo "no tmux session 'nerd' (is the container in tui mode?); a shell instead" >&2
exec /bin/bash -l
