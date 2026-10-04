#!/bin/bash
# /usr/local/bin/pkill and /usr/local/bin/pgrep in the image (ahead of
# /usr/bin in PATH): refuse -f/--full, pass everything else to procps.
#
# With -f the pattern is matched against whole command lines, and the shell
# running the agent's command has that very pattern in its own command line
# (bash -c '... pkill -f "http.server 8000" ...'). pkill then kills the
# agent's shell together with the server: exit 143, the rest of the command
# never runs (5 of 8 runs in the operator-prompt A/B of 2026-10-03). The
# real binaries stay at /usr/bin/pkill and /usr/bin/pgrep.
set -u
me=$(basename "$0")
real=/usr/bin/$me

refuse() {
  cat >&2 <<EOF
$me: -f/--full is refused in this container. A pattern matched against full
command lines also matches the shell running this very command (its command
line contains the pattern), so that shell is killed too (exit 143) and the
rest of the command never runs. Instead:
  - match the process name exactly: $me -x python3
  - keep the pid when starting: cmd > app.log 2>&1 & echo \$! > app.pid
    and later: kill "\$(cat app.pid)"
  - use \$! right after starting it in the same command
  - for a server, find it by its port: ss -ltnp 'sport = :8000'
EOF
  exit 2
}

# Short options of procps pgrep/pkill that take a value: the rest of the
# cluster (or the next word) is that value, not more flags.
with_value=dgGOPstuUFrq
skip_next=0
first=1
for a in "$@"; do
  if [ "$skip_next" = 1 ]; then skip_next=0; first=0; continue; fi
  case "$a" in
    --) break ;;
    --full|--full=*) refuse ;;
    --*) ;;
    -?*)
      # pkill's signal as the first word: -9, -KILL, -SIGTERM, -term.
      if [ "$first" = 1 ] && [ "$me" = pkill ] && kill -l "${a#-}" >/dev/null 2>&1; then first=0; continue; fi
      flags=${a#-}
      while [ -n "$flags" ]; do
        c=${flags:0:1}; flags=${flags:1}
        [ "$c" = f ] && refuse
        case "$with_value" in *"$c"*) [ -z "$flags" ] && skip_next=1; break ;; esac
      done ;;
  esac
  first=0
done
exec "$real" "$@"
