#!/usr/bin/env bash
# Everything to send back when nerd does not work (or to report a first run):
# one archive with the logs of ./UP and the host scripts, the server's and the
# agent's logs, the output of the checks, and what the machine is. Written for
# bash 3.2 too (macOS's own), since it is run exactly when something is off.
#   tools/report.sh            -> var/report/nerd-report-<time>.tar.gz
# Long logs are cut to their last 5000 lines. Tokens in .env (HF_TOKEN and any
# *TOKEN*/*KEY*/*SECRET* value) are replaced by "***"; private keys are never
# read. Look into the archive before sending if in doubt: the list is printed.
set -u
# shellcheck source=tools/lib.sh
. "$(dirname "$0")/lib.sh"
nerd_load_env
nerd_settings 2>/dev/null || true

stamp=$(date +%Y%m%d-%H%M%S)
out=$NERD_ROOT/var/report
work=$out/nerd-report-$stamp
mkdir -p "$work" || { echo "report: cannot create $work" >&2; exit 1; }
host_dir=${NERD_HOST_DIR:-$HOME/.nerd}
TAIL=5000

# Run a command with a time limit (macOS has no `timeout`): a stuck docker must
# not stop the report.
limited() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) & local guard=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null
  return $rc
}
section() { printf '\n===== %s\n' "$1"; }
cmd() { section "$*"; limited 60 "$@" 2>&1; echo "[rc=$?]"; }

{
  section "nerd"
  echo "report $stamp, $(git -C "$NERD_ROOT" log -1 --format='%h %cs %s' 2>/dev/null)"
  git -C "$NERD_ROOT" status --short 2>&1 | head -50
  cmd uname -a
  echo "bash $BASH_VERSION"
  case "$(uname -s)" in
    Darwin)
      cmd sw_vers
      cmd sysctl -n machdep.cpu.brand_string hw.memsize hw.ncpu
      cmd python3 --version
      cmd vm_stat ;;
    Linux)
      cmd cat /etc/os-release
      grep -qi microsoft /proc/version 2>/dev/null && echo "WSL2: yes"
      cmd free -h
      cmd nvidia-smi ;;
  esac
  cmd df -h "$NERD_ROOT"
  cmd docker version
  section "docker info (short)"
  limited 60 docker info --format '{{.OperatingSystem}} | {{.NCPU}} CPU | {{.MemTotal}} bytes | runtimes {{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>&1
  cmd docker compose version
  cmd docker ps -a --filter "name=$NERD_NAME"
} > "$work/system.txt" 2>&1

# The checks: their own output, whatever bash they need.
limited 300 "$NERD_ROOT/tools/check-prerequisites.sh" > "$work/check-prerequisites.txt" 2>&1
limited 120 "$NERD_ROOT/STATUS" > "$work/status.txt" 2>&1

# .env with secrets masked.
if [ -f "$NERD_ROOT/.env" ]; then
  # No GNU-only flags: this runs with macOS's sed too. Names in .env are upper case.
  sed -E 's/^([[:space:]]*[A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=).+/\1***/' \
    "$NERD_ROOT/.env" > "$work/env.txt"
fi

# Logs of ./UP and the host scripts (small; all of them).
[ -d "$NERD_ROOT/var/log" ] && cp -R "$NERD_ROOT/var/log" "$work/var-log"

# The host server's logs (macOS, or NERD_LLAMA=host): the end of each.
if [ -d "$host_dir" ]; then
  mkdir -p "$work/host"
  for f in "$host_dir"/*.log; do
    [ -f "$f" ] && tail -n "$TAIL" "$f" > "$work/host/$(basename "$f")"
  done
fi

# The containers' logs.
for c in "$NERD_NAME" "$NERD_NAME-llm"; do
  if limited 30 docker inspect "$c" >/dev/null 2>&1; then
    limited 60 docker logs --tail "$TAIL" "$c" > "$work/docker-$c.log" 2>&1
  fi
done

tar -C "$out" -czf "$work.tar.gz" "$(basename "$work")" || { echo "report: tar failed; the files are in $work" >&2; exit 1; }
echo "report: $work.tar.gz ($(du -h "$work.tar.gz" | cut -f1)), with:"
(cd "$work" && find . -type f | sed 's|^\./|  |' | sort)
echo "Send this one file. The unpacked copy stays in $work."
