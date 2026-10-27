// Lint after every edit (lint-check.ts): the parsers of the three linters'
// output always; the linters themselves where they are on PATH (the agent's
// image has all three; elsewhere those tests are skipped).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { foreignNames, inlineScripts, lintFile, lintNote, lintOn, lintRust, parseBiome, parseRuff, parseRustc, parseShellcheck } from "../src/lint-check.ts";
import { tempDir } from "./tmp.ts";

const on = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const dir = tempDir("nerd-lint-test-");
const file = (name: string, text: string) => {
	const f = join(dir, name);
	writeFileSync(f, text);
	return f;
};

test("lint: the three output formats parse to line and message", () => {
	assert.deepEqual(
		parseBiome(
			"::error title=parse,file=/w/a.js,line=2,endLine=2,col=7,endColumn=8::Expected a semicolon\n" +
				"::error title=lint/correctness/noUndeclaredVariables,file=/w/b.mjs,line=1,endLine=1,col=17,endColumn=32::The WebSocketServer variable is undeclared.\n" +
				"lint ━━━━ \n  × Some errors were emitted",
		),
		[
			{ line: 2, text: "Expected a semicolon" },
			{ line: 1, text: "The WebSocketServer variable is undeclared. (correctness/noUndeclaredVariables)" },
		],
	);
	assert.deepEqual(parseRuff("bad.py:5:1: invalid-syntax: unexpected EOF while parsing\nFound 1 error.\n"), [
		{ line: 5, text: "invalid-syntax: unexpected EOF while parsing" },
	]);
	assert.deepEqual(parseShellcheck("/tmp/x.sh:3:8: error: Couldn't parse this double quoted string. [SC1073]\n"), [
		{ line: 3, text: "Couldn't parse this double quoted string. [SC1073]" },
	]);
});

test("lint: inline scripts with their line, src= and JSON skipped; the note lists lines", () => {
	const html = '<html>\n<script src="a.js"></script>\n<script type="application/json">{}</script>\n<script type="module">\nlet x.y = 1;\n</script>';
	assert.deepEqual(inlineScripts(html), [["\nlet x.y = 1;\n", true, 4]]);
	const note = lintNote("public/app.js", [{ line: 2, text: "Expected a semicolon" }]);
	assert.match(note, /^\[lint\] public\/app\.js: 1 error:\n {2}line 2: Expected a semicolon\nFix these/);
	assert.doesNotMatch(note, /never assigned/, "no hint without an undeclared name");
	// 0006g: `io` only called — the socket.io client was never loaded; 0006r2: `myElement` is
	// the page's own state, assigned on a reset — declaring it is the fix, no hint.
	const io = [{ line: 9, text: "<script>: The io variable is undeclared. (correctness/noUndeclaredVariables)" }];
	assert.match(lintNote("public/index.html", io, "const socket = io();\nif (typeof io === 'undefined') x();\n"), /`io` is never assigned in this file: .*only hides the error\.$/);
	const own = [{ line: 394, text: "<script>: The myElement variable is undeclared. (correctness/noUndeclaredVariables)" }];
	assert.doesNotMatch(lintNote("public/game.html", own, "case 'match_reset':\n  myElement = null;\n"), /never assigned/);
	assert.deepEqual(foreignNames([...io, ...own], "myElement++;\nconst f = io => io == 1;\n"), ["io"], "`=>` and `==` are no assignment");
	assert.match(lintNote("a.py", [{ line: 1, text: "F821 Undefined name `foo`" }], "print(foo)\n"), /`foo` is never assigned/);
	assert.doesNotMatch(lintNote("public/index.html", io), /never assigned/, "no file text (over a MiB): no hint");
	assert.equal(lintOn({}), true);
	assert.equal(lintOn({ NERD_LINT: "0" }), false);
});

test("lint: biome — 036's errors are reported, style and browser/Node globals are not", { skip: !on("biome") }, () => {
	const parse = lintFile(file("parse.js", "let ws = {};\nlet ws.closedByUs = false;\n"));
	assert.equal(parse.length > 0, true, "the unparsable line of 036");
	assert.equal(parse[0].line, 2);
	const imp = lintFile(file("noimport.mjs", 'const wss = new WebSocketServer({ port: 8080 });\nwss.on("connection", (s) => s.send("hi"));\n'));
	assert.match(imp[0]?.text ?? "", /WebSocketServer/, "the missing import of 036");
	assert.deepEqual(lintFile(file("style.js", 'var x = 1\nif (x == 1) { console.log("one") }\nmodule.exports = { x }\n')), [], "style only");
	assert.deepEqual(
		lintFile(file("browser.js", 'document.getElementById("b").addEventListener("click", () => fetch("/api").then((r) => r.json()));\nwindow.x = 1;\n')),
		[],
	);
	assert.deepEqual(lintFile(file("server.mjs", 'import http from "node:http";\nhttp.createServer((q, s) => s.end("x")).listen(Number(process.env.PORT ?? 8000));\n')), []);
	const html = lintFile(file("index.html", "<html>\n<body>\n<script>\nlet ws.closedByUs = false;\n</script>\n</body>\n</html>\n"));
	assert.equal(html[0]?.line, 4, "an inline script's error at its line in the page");
	assert.deepEqual(lintFile(file("ok.json", '{"a": 1}')), []);
	assert.equal(lintFile(file("bad.json", '{"a": 1,,}')).length > 0, true);
});

test("lint: ruff — a syntax error and an undefined name, not style", { skip: !on("ruff") }, () => {
	assert.equal(lintFile(file("bad.py", "def f(x):\n    return x\nprint(f(1)\n")).length > 0, true);
	assert.match(lintFile(file("undef.py", "def f(x):\n    return y + 1\n"))[0]?.text ?? "", /y/);
	assert.deepEqual(lintFile(file("style.py", "import os, sys\ndef g( a ):\n  return a+1\n")), []);
});

test("lint: rustc's short lines — the edited file's errors by line, the rest as a count", () => {
	const ps = parseRustc(["src/lib.rs:3:5: error[E0308]: mismatched types", "src/other.rs:1:1: error: expected item"], "/c", "/c/src/lib.rs");
	assert.deepEqual(ps, [
		{ line: 3, text: "error[E0308]: mismatched types" },
		{ line: 0, text: "and 1 error elsewhere in the crate (`cargo check` shows them)" },
	]);
	assert.match(lintNote("src/lib.rs", ps), /line 3: error\[E0308\][^\n]*\n {2}and 1 error elsewhere/);
});

test("lint: cargo check — a .rs file's errors, not its warnings", { skip: !on("cargo") && "cargo not on PATH" }, () => {
	const c = tempDir("nerd-lint-crate-");
	mkdirSync(join(c, "src"));
	writeFileSync(join(c, "Cargo.toml"), '[package]\nname = "l"\nversion = "0.1.0"\nedition = "2021"\n');
	writeFileSync(join(c, "src/lib.rs"), "pub fn f() -> u32 {\n    let unused = 1;\n    7\n}\n");
	assert.deepEqual(lintRust(join(c, "src/lib.rs")), [], "a warning is not reported");
	writeFileSync(join(c, "src/lib.rs"), 'pub fn f() -> u32 {\n    "seven"\n}\n');
	const ps = lintRust(join(c, "src/lib.rs"));
	assert.equal(ps[0]?.line, 2);
	assert.match(ps[0]?.text ?? "", /error\[E0308\]/);
	assert.deepEqual(lintRust(join(dir, "loose.rs")), [], "a .rs file outside any crate is left alone");
});

test("lint: shellcheck — an unparsable script, by extension or #!", { skip: !on("shellcheck") }, () => {
	assert.equal(lintFile(file("bad.sh", '#!/bin/bash\nif [ -f x ]; then\n  echo "unterminated\nfi\n')).length > 0, true);
	assert.equal(lintFile(file("run", '#!/bin/sh\necho "unterminated\n')).length > 0, true);
	assert.deepEqual(lintFile(file("ok.sh", '#!/bin/bash\necho "$1"\n')), []);
});
