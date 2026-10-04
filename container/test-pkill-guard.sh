#!/bin/bash
# Checks container/pkill-guard.sh. In the image: bash /opt/nerd/test-pkill-guard.sh
# (pkill and pgrep from PATH are the guard). Elsewhere: GUARD=container/pkill-guard.sh
# bash container/test-pkill-guard.sh (the guard is linked as pkill/pgrep in a temp dir).
set -u
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -n "${GUARD:-}" ]; then
  ln -s "$(realpath "$GUARD")" "$tmp/pkill"; ln -s "$(realpath "$GUARD")" "$tmp/pgrep"
  PATH=$tmp:$PATH
fi
fails=0
# refused <cmd...>: exit 2 with the explanation
refused() {
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" = 2 ] && grep -q 'is refused in this container' <<<"$out"; then echo "ok   refused: $*"
  else echo "FAIL not refused (rc $rc): $*"; fails=$((fails + 1)); fi
}
# passed <cmd...>: reaches procps (no refusal), whatever its exit code
passed() {
  out=$("$@" 2>&1); rc=$?
  if grep -q 'is refused' <<<"$out"; then echo "FAIL refused: $*"; fails=$((fails + 1))
  else echo "ok   passed (rc $rc): $*"; fi
}
refused pgrep -f http.server
refused pgrep --full http.server
refused pgrep -af http.server
refused pgrep -lf http.server
refused pkill -f "python3 -m http.server 8000"
refused pkill -9 -f http.server
refused pkill -KILL -f http.server
refused pkill -SIGTERM --full http.server
refused pkill -x -f sleep
passed pgrep -x bash
passed pgrep -l -x bash
passed pgrep -d f -x bash
passed pgrep -O1 -x bash
passed pgrep -u "$(id -un)" -x bash
passed pkill -0 -x nerd-no-such-process
passed pgrep -- -f

# The guard passes a real kill through: a uniquely named sleep, killed by name.
cp "$(command -v sleep)" "$tmp/nerdguardzz"
"$tmp/nerdguardzz" 300 & pid=$!
sleep 0.3
pkill -x nerdguardzz; sleep 0.3
if kill -0 "$pid" 2>/dev/null; then echo "FAIL pkill -x did not kill $pid"; fails=$((fails + 1)); kill "$pid"
else echo "ok   pkill -x nerdguardzz killed it"; fi

# What the guard prevents: the shell that runs a full-cmdline pkill survives it.
bash -c 'pkill -f "nerdguard-pattern-zz"; echo "shell still alive"' > "$tmp/self.txt" 2>&1
rc=$?
if [ "$rc" != 143 ] && grep -q "shell still alive" "$tmp/self.txt"; then echo "ok   the calling shell survives (rc $rc)"
else echo "FAIL the calling shell died (rc $rc)"; fails=$((fails + 1)); fi

echo "failures: $fails"
[ "$fails" = 0 ]
