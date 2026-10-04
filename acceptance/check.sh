#!/bin/bash
# Acceptance check of a handed-in game (decision 0006, criteria 5-10 and 13)
# in a clean container. Needs bash, tar, git (for a git input) and docker;
# network only to pull images and for npm ci.
#
#   acceptance/check.sh <input> <out-dir>
#
# <input> is the agent's repository (its HEAD is checked out with git archive:
# what is committed is what was handed in; uncommitted paths are counted in
# the report), a plain directory (copied without node_modules and .git), or a
# .tar of either. The copy goes into a fresh container of the official
# node:lts image (ACC_NODE_IMAGE overrides): no agent volume, no npm cache.
# Headless Chromium runs in a second container that shares the first one's
# network namespace, so a server bound to 127.0.0.1 is reachable too.
#
# Result: <out-dir>/report.md and report.json, verdict per criterion PASS,
# FAIL or OPERATOR (the operator decides from the evidence next to it).
# Exit code: 0 no FAIL, 1 at least one FAIL, 3 the checker itself broke.
set -uo pipefail
[ $# -eq 2 ] || { sed -n '2,18p' "$0"; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
in=$1
mkdir -p "$2" && out=$(cd "$2" && pwd)
NODE_IMAGE=${ACC_NODE_IMAGE:-node:lts}
PW=${ACC_PLAYWRIGHT:-1.63.0}
BIMG=nerd-acceptance-browser:$PW
id=acc-$(date +%Y%m%d%H%M%S)-$$
work=$(mktemp -d)
cleanup() {
	docker rm -f "$id-app" "$id-browser" >/dev/null 2>&1
	docker volume rm "$id-out" >/dev/null 2>&1
	rm -rf "$work"
}
trap cleanup EXIT
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "checker error: $*"; exit 3; }
app() { docker exec -w /app "$id-app" "$@"; }
appsh() { docker exec -w /app "$id-app" sh -c "$1"; }
started=$(date -Iseconds)

# ---- the handed-in source ----
commit= uncommitted=
if [ -f "$in" ]; then
	cp "$in" "$work/src.tar" || die "cannot read $in"
	input="$(basename "$in") (tar)"
elif [ -d "$in" ] && top=$(git -C "$in" rev-parse --show-toplevel 2>/dev/null) &&
	[ "$top" = "$(cd "$in" && pwd -P)" ] && git -C "$in" rev-parse --verify -q HEAD >/dev/null; then
	git -C "$in" archive --format=tar HEAD >"$work/src.tar" || die "git archive failed"
	commit=$(git -C "$in" rev-parse --short HEAD)
	uncommitted=$(git -C "$in" status --porcelain | wc -l)
	input="$(basename "$in") (git HEAD)"
elif [ -d "$in" ]; then
	tar -C "$in" --exclude=./node_modules --exclude=node_modules --exclude=.git -cf "$work/src.tar" . || die "tar failed"
	input="$(basename "$in") (directory)"
else
	die "no such input: $in"
fi
log "input: $input${commit:+ $commit}"

# ---- images and containers ----
log "pulling $NODE_IMAGE, building $BIMG"
docker pull -q "$NODE_IMAGE" >"$out/docker-pull.log" 2>&1 || die "docker pull $NODE_IMAGE (see docker-pull.log)"
docker build -t "$BIMG" --build-arg PW="$PW" -f "$here/browser/Dockerfile" "$here" >"$out/browser-build.log" 2>&1 ||
	die "browser image build (see browser-build.log)"
docker volume create "$id-out" >/dev/null || die "docker volume"
docker run -d --name "$id-app" -v "$id-out:/out" "$NODE_IMAGE" sleep infinity >/dev/null || die "docker run"
docker exec "$id-app" mkdir -p /app /acc /out/browser || die "mkdir"
docker cp -q "$work/src.tar" "$id-app:/tmp/src.tar" && docker cp -q "$here/lib" "$id-app:/acc/lib" || die "docker cp"
app tar -xf /tmp/src.tar -C /app || die "untar"
docker exec -e ACC_INPUT="$input" -e ACC_COMMIT="$commit" -e ACC_UNCOMMITTED="$uncommitted" \
	-e ACC_IMAGE="$NODE_IMAGE $(docker image inspect -f '{{index .RepoDigests 0}}' "$NODE_IMAGE" 2>/dev/null)" \
	-e ACC_BROWSER="playwright $PW, chromium headless" -e ACC_STARTED="$started" \
	"$id-app" sh -c 'node /acc/lib/cli.mjs meta > /out/meta.json'

# ---- P5: npm ci && npm test ----
log "P5: npm ci, npm test"
appsh 'timeout 900 npm ci --no-audit --no-fund > /out/p5-npm-ci.log 2>&1; echo $? > /out/p5-npm-ci.rc'
appsh 'timeout 900 npm test > /out/p5-npm-test.log 2>&1 < /dev/null; echo $? > /out/p5-npm-test.rc'

# ---- P6: the start command serves HTML ----
appsh 'node /acc/lib/cli.mjs start-command /app > /out/p6-command.json'
start=$(app node /acc/lib/cli.mjs field /out/p6-command.json cmd)
url=
if [ -n "$start" ]; then
	log "P6: $start"
	docker exec -d -w /app -e PORT=8000 -e HOST=0.0.0.0 "$id-app" sh -c "exec $start > /out/p6-server.log 2>&1 < /dev/null"
	appsh 'node /acc/lib/cli.mjs wait-http /out/p6-server.log 60 > /out/p6.json'
	[ "$(app node /acc/lib/cli.mjs field /out/p6.json verdict)" = PASS ] && url=$(app node /acc/lib/cli.mjs field /out/p6.json url)
else
	log "P6: no start command"
fi

# ---- P7 (pages), P8, P9, P13: headless browser ----
if [ -n "$url" ]; then
	log "P7-P9, P13: browser on $url"
	docker run --name "$id-browser" --network "container:$id-app" -v "$id-out:/out" --shm-size 1g "$BIMG" \
		timeout 1500 node /acc/browser/browse.mjs "$url" /out/browser >"$work/browser.log" 2>&1
	docker cp -q "$work/browser.log" "$id-app:/out/browser.log"
fi

# ---- P7 (command), if the game has one ----
appsh 'node /acc/lib/cli.mjs rules-command /app > /out/p7-rules-command.json'
rules=$(app node /acc/lib/cli.mjs field /out/p7-rules-command.json cmd)
[ -n "$rules" ] && appsh "timeout 120 $rules > /out/p7-rules-cmd.log 2>&1 < /dev/null"

# ---- P10: the rank command ----
appsh 'node /acc/lib/cli.mjs rank-command /app > /out/p10-command.json'
rank=$(app node /acc/lib/cli.mjs field /out/p10-command.json cmd)
if [ -n "$rank" ]; then
	log "P10: $rank"
	appsh "timeout 1800 $rank > /out/p10-rank.log 2>&1 < /dev/null; echo \$? > /out/p10.rc"
else
	log "P10: no rank command"
fi

# ---- report ----
appsh 'node /acc/lib/report.mjs /out > /out/summary.txt' || die "report"
docker cp -q "$id-app:/out/." "$out/" || die "copy results out"
cat "$out/report.md"
log "$(cat "$out/summary.txt")"
grep -q '^| P[0-9]* | \*\*FAIL\*\*' "$out/report.md" && exit 1
exit 0
