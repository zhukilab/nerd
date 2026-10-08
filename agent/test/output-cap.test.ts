// Long bash output cut to head and tail (output-cap.ts, ticket 057 of the
// process): the line that says what failed stays in sight, the rest is in a file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { capBashText, collapseRuns, DEFAULT_MAX_CHARS, headTail, outputMax } from "../src/output-cap.ts";
import { QUIET_ENV, quietEnv } from "../src/bash-tool.ts";
import { tempDir } from "./tmp.ts";

const kept: Record<string, string> = {};
const keepFile = (t: string) => {
	const p = `/kept/${Object.keys(kept).length}.log`;
	kept[p] = t;
	return p;
};

test("output cap: short output is left alone, the limit is 8000 unless NERD_BASH_MAX_CHARS says otherwise", () => {
	assert.equal(capBashText("ok\n3 passed", 8000), undefined);
	assert.equal(capBashText(`${"x".repeat(9000)}\n\nCommand exited with code 1`, 0), undefined, "0: off");
	assert.equal(outputMax({}), DEFAULT_MAX_CHARS);
	assert.equal(outputMax({ NERD_BASH_MAX_CHARS: "0" }), 0);
	assert.equal(outputMax({ NERD_BASH_MAX_CHARS: "12000" }), 12000);
});

test("output cap: a long failing node:test run keeps the failing tests, the assertion and the counts", () => {
	const d = tempDir("nerd-cap-");
	const body = [];
	for (let i = 0; i < 150; i++) {
		body.push(`test("case number ${i} of the allocation table", () => { assert.equal(${i === 71 || i === 140 ? i + 1 : i}, ${i}); });`);
	}
	writeFileSync(join(d, "big.test.mjs"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body.join("\n")}\n`);
	// Without NODE_TEST_CONTEXT, or the child reports to this runner, not to stdout.
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", join(d, "big.test.mjs")], { encoding: "utf8", env: { ...env, NO_COLOR: "1" } });
	const out = `${r.stdout}${r.stderr}`.trimEnd();
	assert.ok(out.length > DEFAULT_MAX_CHARS, `the run is long enough (${out.length})`);
	const capped = capBashText(`${out}\n\nCommand exited with code 1`, DEFAULT_MAX_CHARS, undefined, keepFile);
	assert.ok(capped);
	assert.ok(capped.length < DEFAULT_MAX_CHARS + 600, `cut to the budget (${capped.length})`);
	assert.match(capped, /case number 71 of the allocation table/, "a failing test's name");
	assert.match(capped, /case number 140 of the allocation table/, "the other one");
	assert.match(capped, /\bfail 2\b/, "the count");
	assert.match(capped, /Expected values to be strictly equal/, "the assertion");
	assert.match(capped, /Command exited with code 1$/, "Pi's exit line kept");
	assert.match(capped, /lines left out here\. The whole output .* is in \/kept\/\d+\.log/);
	const path = capped.match(/is in (\S+):/)?.[1] ?? "";
	assert.equal(kept[path], out, "the file holds all of it");
});

test("output cap: a long build log keeps the error at its end", () => {
	const lines = [];
	for (let i = 0; i < 900; i++) lines.push(`[build] compiling src/module${i}.ts ... done (${i % 17} ms)`);
	lines.push("src/server.ts(214,17): error TS2304: Cannot find name 'myPick'.");
	lines.push("Found 1 error in src/server.ts:214");
	const capped = capBashText(`${lines.join("\n")}\n\nCommand exited with code 2`, DEFAULT_MAX_CHARS, undefined, keepFile);
	assert.ok(capped);
	assert.match(capped, /error TS2304: Cannot find name 'myPick'/);
	assert.match(capped, /^\[build\] compiling src\/module0\.ts/, "the head too");
});

test("output cap: an error in the middle of a long log is shown with its line number", () => {
	const lines = [];
	for (let i = 1; i <= 3000; i++) lines.push(i === 1200 ? "ERROR data/rates-07.json: field 'rate' must be a number, got string \"0.15\"" : `[build] module ${i} ok`);
	lines.push("Build failed: 1 error (see above)");
	const capped = capBashText(lines.join("\n"), DEFAULT_MAX_CHARS, undefined, keepFile);
	assert.ok(capped);
	assert.match(capped, /look like errors \(line: text\):\n1200: ERROR data\/rates-07\.json: field 'rate' must be a number/);
	assert.match(capped, /Build failed: 1 error \(see above\)$/);
	assert.ok(capped.length < DEFAULT_MAX_CHARS + 800, `within the budget (${capped.length})`);
});

test("output cap: a run of identical lines collapses, which may be enough by itself", () => {
	assert.deepEqual(collapseRuns(["a", "a", "b", "c", "c", "c", "c", "d"]), ["a", "a", "b", "c  [x4 identical lines]", "d"]);
	const done = `${"Done\n".repeat(17972)}CLOSED`;
	const t = headTail(done, DEFAULT_MAX_CHARS, "/f.log");
	assert.match(t, /^Done {2}\[x17972 identical lines\]\nCLOSED\n\[harness\] Identical lines collapsed\./);
});

test("output cap: when Pi cut the output, its file gives the true head", () => {
	const full = Array.from({ length: 60000 }, (_, i) => `[C${i}] message ${i}`).join("\n");
	const piText = `${full.slice(-51200)}\n\n[Showing lines 57522-60000 of 60000 (50.0KB limit). Full output: /tmp/pi-bash-1.log]`;
	const read = (p: string) => {
		assert.equal(p, "/tmp/pi-bash-1.log");
		return `${full}\n`;
	};
	const capped = capBashText(piText, DEFAULT_MAX_CHARS, read, keepFile);
	assert.ok(capped);
	assert.match(capped, /^\[C0\] message 0\n/, "head from Pi's file");
	assert.match(capped, /\[C59999\] message 59999$/, "tail");
	assert.match(capped, /The whole output \(60000 lines, .*\) is in \/tmp\/pi-bash-1\.log/);
});

test("output cap: the same output gives the same text (the loop guard still sees a repeat)", () => {
	const out = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = tempDir("nerd-cap-files-");
	const a = capBashText(out, DEFAULT_MAX_CHARS);
	const b = capBashText(out, DEFAULT_MAX_CHARS);
	process.env.TMPDIR = saved;
	assert.ok(a);
	assert.equal(a, b);
	const path = a.match(/is in (\S+):/)?.[1] ?? "";
	assert.equal(readFileSync(path, "utf8"), out);
});

test("quiet defaults: added under the command's own environment, off with NERD_QUIET=0", () => {
	const e = quietEnv({ PATH: "/bin", NO_COLOR: "" }, {});
	assert.equal(e.PATH, "/bin");
	assert.equal(e.NO_COLOR, "", "a variable already set wins");
	assert.equal(e.NPM_CONFIG_FUND, "false");
	assert.deepEqual(quietEnv({ PATH: "/bin" }, { NERD_QUIET: "0" }), { PATH: "/bin" });
	assert.ok(Object.keys(QUIET_ENV).includes("GIT_PAGER"));
});
