#!/bin/bash
# Self-test of check.sh: the reference game must pass every criterion, and
# each broken copy (fixtures/broken/<name>.patch on top of the reference)
# must fail the criterion it breaks.
#   acceptance/selftest.sh <out-dir> [variant ...]
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: selftest.sh <out-dir> [variant ...]}
shift
mkdir -p "$out" && out=$(cd "$out" && pwd)
declare -A expect=(
	[reference]="P5=PASS P6=PASS P7=PASS P8=PASS P9=PASS P10=PASS P13=PASS"
	[wrong-cycle]="P7=FAIL"
	[no-tests]="P5=FAIL"
	[no-server]="P6=FAIL"
	[equal-bots]="P10=FAIL"
	[hscroll]="P13=FAIL"
)
variants=("$@")
[ ${#variants[@]} -gt 0 ] || variants=(reference wrong-cycle no-tests no-server equal-bots hscroll)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bad=0
for v in "${variants[@]}"; do
	src="$work/$v"
	cp -r "$here/fixtures/reference" "$src"
	rm -rf "$src/node_modules"
	if [ "$v" != reference ]; then
		(cd "$src" && git apply -p1 "$here/fixtures/broken/$v.patch") || { echo "$v: patch does not apply"; bad=1; continue; }
	fi
	"$here/check.sh" "$src" "$out/$v" >"$out/$v.log" 2>&1
	got=$(grep -o '^| P[0-9]* | \*\*[A-Z]*\*\*' "$out/$v/report.md" 2>/dev/null | tr -d '|* ' | sed 's/\(P[0-9]*\)/\1=/' | tr '\n' ' ')
	miss=
	for e in ${expect[$v]}; do [[ " $got " == *" $e "* ]] || miss+=" $e"; done
	if [ -z "$miss" ]; then echo "ok   $v: $got"; else echo "FAIL $v: expected$miss; got: $got"; bad=1; fi
done
exit $bad
