#!/bin/bash
# Checks `browse` inside the image: test pages served by python's http.server.
#   docker run --rm --entrypoint /opt/nerd/test-browse.sh nerd
# Prints PASS/FAIL per case (with browse's output: FAIL always, PASS with
# -e VERBOSE=1); exit code = number of failures.
set -u
d=$(mktemp -d)
port=${1:-18765}
trap 'kill $srv 2>/dev/null; rm -rf "$d"' EXIT

cat > "$d/good.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>good</title></head><body>
<h1>Counter</h1><p id="n">0</p>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('n').textContent = Number(document.getElementById('n').textContent) + 1">Add one</button>
<button onclick="document.getElementById('n').textContent = 'hello ' + document.getElementById('name').value">Greet</button>
<button onclick="nope()">Boom</button>
<button disabled>Off</button>
<label>Colour <select id="c"><option value="">pick</option><option value="r">Red</option><option value="g">Green</option></select></label>
<button onclick="document.getElementById('n').textContent = 'colour ' + document.getElementById('c').value">Show</button>
<button onclick="document.getElementById('n').textContent = confirm('Sure?') ? 'confirmed' : 'refused'">Ask</button>
<button onclick="localStorage.setItem('k', 'kept')">Save</button>
<p id="s"></p><script>document.getElementById('s').textContent = 'stored ' + (localStorage.getItem('k') || 'none')</script>
</body></html>
EOF
cat > "$d/syntax.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>syntax</title></head><body>
<p>page with a broken script</p>
<script src="broken.js"></script>
</body></html>
EOF
# The line that killed the first hand-in of the 036 run.
printf '%s\n' '// client' 'let ws.closedByUs = false;' > "$d/broken.js"
# HTML under a name the server types as text/plain: the 036 failure.
cp "$d/good.html" "$d/page.txt"
cat > "$d/module.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>module</title></head><body>
<p>module script with a wrong type</p>
<script type="module" src="app.txt"></script>
<img src="missing.png">
</body></html>
EOF
echo 'document.body.append("ran")' > "$d/app.txt"

python3 -m http.server "$port" --bind 127.0.0.1 -d "$d" > "$d/server.log" 2>&1 &
srv=$!
for _ in $(seq 50); do curl -sf -o /dev/null "http://127.0.0.1:$port/good.html" && break; sleep 0.1; done

fails=0
# case <name> <expected rc> <grep -E pattern the output must match> -- browse args...
check() {
	local name=$1 want=$2 pat=$3; shift 4
	local out rc
	out=$(browse "$@" 2>&1); rc=$?
	if [ "$rc" = "$want" ] && grep -qE -- "$pat" <<<"$out"; then
		echo "PASS $name (rc=$rc)"
		[ -n "${VERBOSE:-}" ] && sed 's/^/    /' <<<"$out"
	else
		echo "FAIL $name (rc=$rc, want $want, pattern /$pat/)"; sed 's/^/    /' <<<"$out"
		fails=$((fails + 1))
	fi
}
u=http://127.0.0.1:$port
check clean           0 'Content-Type: text/html'                 -- "$u/good.html"
check click-and-fill  0 'hello Ada'                               -- "$u/good.html" --click "Add one" --fill "Name=Ada" --click Greet
check select-label    0 'colour g'                                -- "$u/good.html" --fill "Colour=Green" --click Show
check select-value    0 'colour r'                                -- "$u/good.html" --fill "c=r" --click Show
check confirm-ok      0 'confirm "Sure\?": accepted'              -- "$u/good.html" --click Ask
check confirm-result  0 'confirmed'                               -- "$u/good.html" --click Ask
check reload-storage  0 'stored kept'                             -- "$u/good.html" --click Save --reload
check click-missing   2 'click "Nope": FAILED'                    -- "$u/good.html" --click Nope
check syntax-error    1 'uncaught SyntaxError.*broken.js:2'       -- "$u/syntax.html"
check runtime-error   1 '\[click "Boom"\] uncaught ReferenceError: nope' -- "$u/good.html" --click Boom
check click-disabled  2 'click "Off": FAILED: the element is disabled' -- "$u/good.html" --click Off
check text-plain      1 'main document is not HTML'               -- "$u/page.txt"
check module-mime     1 'MIME type'                               -- "$u/module.html"
check http-404        1 'HTTP 404'                                -- "$u/module.html"
check unreachable     2 'could not open'                          -- "http://127.0.0.1:$((port + 1))/"
check screenshot      0 'screenshot: '                            -- "$u/good.html" --shot "$d/s.png" --width 390
[ -s "$d/s.png" ] || { echo "FAIL screenshot file empty"; fails=$((fails + 1)); }
echo "failures: $fails"
exit "$fails"
