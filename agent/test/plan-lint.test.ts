// plan-lint (ticket 065 of the process): the harness checks PLAN.md after the
// plan step, before the plan is frozen. The fixtures are the Done when lines of
// plans models wrote on the stand of ticket 060 (2026-10-09), where every Ralph
// stop came from a check the frozen plan could not fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDoneWhen, syntaxError, unfailable } from "../src/done-when.ts";
import { lintPlan, lintRetryMessage, planLintOn } from "../src/plan-lint.ts";

const plan = (done: string, steps = "1. write it — check: `npm test`") => `# Plan

## Task

> do it

## Steps
${steps}

## Done when
${done}
`;

const errors = (text: string, checks = true) => lintPlan(text, { checks }).filter((f) => f.severity === "error");
const warnings = (text: string, checks = true) => lintPlan(text, { checks }).filter((f) => f.severity === "warning");

test("parseDoneWhen: the command written inside the claim, then 'check: exits 0'", () => {
	const items = parseDoneWhen(
		plan("- Spec example holds: `node -e \"require('assert').ok(1)\"` — check: exits 0.\n- Full suite passes: `npm test` — check: exits 0 and prints PASS."),
	);
	assert.deepEqual(items, [
		{ claim: "Spec example holds:", cmd: "node -e \"require('assert').ok(1)\"" },
		{ claim: "Full suite passes:", cmd: "npm test" },
	]);
});

test("parseDoneWhen: the item is the command, then 'exits 0'", () => {
	const items = parseDoneWhen(plan("- `npm test` exits 0 with all tests passing\n- `test -f out.txt` exits with 0"));
	assert.deepEqual(items, [
		{ claim: "`npm test` exits 0 with all tests passing", cmd: "npm test" },
		{ claim: "`test -f out.txt` exits with 0", cmd: "test -f out.txt" },
	]);
});

test("parseDoneWhen: the old form is unchanged, and a code span in a claim is not a command", () => {
	assert.deepEqual(parseDoneWhen(plan("- `parse('')` throws — check: `npm test`")), [{ claim: "`parse('')` throws", cmd: "npm test" }]);
	assert.deepEqual(parseDoneWhen(plan("- `parse` and `sort` are exported")), [{ claim: "`parse` and `sort` are exported" }]);
});

test("parseDoneWhen: a bare command after 'check:', but not prose", () => {
	// semver-ralph-5 of the plan-only stand kept this form even after the retry.
	assert.deepEqual(parseDoneWhen(plan(`- package.json correct — check: node -e "process.exit(require('./package.json').type==='module'?0:1)"`)), [
		{ claim: "package.json correct", cmd: `node -e "process.exit(require('./package.json').type==='module'?0:1)"` },
	]);
	assert.deepEqual(parseDoneWhen(plan("- it works — check: run the tests and look")), [{ claim: "it works — check: run the tests and look" }]);
});

test("parseDoneWhen: a forgotten closing backtick, and '<claim>: `<command>`'", () => {
	assert.deepEqual(parseDoneWhen(plan("- rejects bad input — check: `node -e \"process.exit(0)\"")), [{ claim: "rejects bad input", cmd: 'node -e "process.exit(0)"' }]);
	assert.deepEqual(parseDoneWhen(plan("- All tests pass: `npm test`\n- exports the function: `slugify`")), [
		{ claim: "All tests pass", cmd: "npm test" },
		{ claim: "exports the function: `slugify`" },
	]);
});

test("parseDoneWhen: 'check:' inside the backticks", () => {
	assert.deepEqual(parseDoneWhen(plan("- `check: npm test` → exit code 0 (all tests pass)")), [
		{ claim: "- `check: npm test` → exit code 0 (all tests pass)".slice(2), cmd: "npm test" },
	]);
});

test("syntaxError: top-level await in node -e is fine (node detects a module)", () => {
	assert.equal(syntaxError(`node -e "const {parse}=await import('./semver.js'); process.exit(parse('1.2.3').major===1?0:1)"`), undefined);
});

test("unfailable: git diff without --exit-code always exits 0", () => {
	assert.match(unfailable("git diff -- test/") ?? "", /git diff/);
	assert.equal(unfailable("git diff --exit-code -- test/"), undefined);
	assert.equal(unfailable("git diff --quiet -- test/"), undefined);
});

test("unfailable: a node script that only prints", () => {
	assert.match(unfailable(`node -e 'import("./semver.js").then(m=>console.log(JSON.stringify(m.parse("1.2.3"))))'`) ?? "", /only prints/);
	assert.equal(unfailable(`node -e "import('./a.js').then(m=>process.exit(m.f()===1?0:1))"`), undefined);
	assert.equal(unfailable(`node -e "require('assert').deepStrictEqual(require('./a')(1),[1])"`), undefined);
	assert.equal(unfailable(`node -e "if (require('./a')(1) !== 1) throw new Error('x')"`), undefined);
});

test("syntaxError: the node script's own syntax, and the shell's", () => {
	// semver-ralph-2 of the stand: one parenthesis too many.
	assert.match(syntaxError(`node -e 'import("./semver.js").then(m=>{console.log(m.compare("1.0.0-alpha","1.0.0"),"1.0.0","1.0.0-alpha"));})'`) ?? "", /does not parse/);
	assert.equal(syntaxError(`node -e 'import("./semver.js").then(m=>{process.exit(m.compare("1.0.0-alpha","1.0.0")===-1?0:1)})'`), undefined);
	assert.equal(syntaxError(`node --input-type=module -e "import {f} from './a.js'; process.exit(f() ? 0 : 1)"`), undefined);
	assert.match(syntaxError("npm test && (echo x") ?? "", /shell/);
	assert.equal(syntaxError("npm test"), undefined);
});

test("lint: a Ralph plan without Done when, or with tool-call markup instead of a plan", () => {
	assert.ok(errors("# Plan\n\n## Steps\n1. a — check: `true`\n").some((f) => /Done when/.test(f.message)));
	assert.ok(errors(plan("- ok — check: `npm test`", "1. a\n<tool_call>\n<function=web_search>")).some((f) => /tool call/.test(f.message)));
});

test("lint: the stops of the 060 stand are all errors", () => {
	const stops = [
		// duration-ralph-1: prints FAIL, exits 0
		`- Every invalid input throws — check: \`node -e "import('./lib/duration.js').then(m=>{['','1x'].forEach(t=>{try{m.parseDuration(t);console.log('FAIL',t)}catch(e){console.log('OK ',t)}})})"\``,
		// semver-ralph-1: $? after a pipe
		"- npm test passes — check: `cd /workspace && npm test 2>&1 | tail -5 && echo $?` (exits 0)",
		// semver-ralph-2: expected output in words; a parse error
		`- parses — check: \`node -e 'import("./semver.js").then(m=>console.log(JSON.stringify(m.parse("1.2.3"))))'\` prints \`{"major":1}\`.`,
		`- compare — check: \`node -e 'import("./semver.js").then(m=>{console.log(m.compare("1.0.0-alpha","1.0.0"),"1"));})'\``,
		// semver-ralph-3: console.assert
		`- \`node -e "import('./semver.js').then(m=>{console.assert(m.parse('1.2.3').major===1)})"\` exits 0`,
		// slug-ralph-1: git diff, and words for the output
		"- No files under `test/` are modified. — check: `git diff -- test/` shows no changes (run from `/workspace`).",
		"- exports slugify — check: `node -e \"import('./lib/slug.js').then(m=>console.log(typeof m.slugify))\"` prints \"function\"",
	];
	for (const s of stops) assert.ok(errors(plan(s)).length > 0, s);
});

test("lint: a good Ralph plan has no errors and no warnings", () => {
	const good = plan(
		"- The tests pass — check: `npm test`\n- parse rejects '1.2' — check: `node -e \"import('./semver.js').then(m=>{try{m.parse('1.2')}catch{process.exit(0)}process.exit(1)})\"`\n- no dependencies — check: `! grep -q '\"dependencies\"' package.json`",
	);
	assert.deepEqual(lintPlan(good, { checks: true }), []);
});

test("lint: warnings — /workspace in a check, a grep that must find nothing, a step without check", () => {
	assert.ok(warnings(plan("- tests pass — check: `cd /workspace && npm test`")).some((f) => /clean clone/.test(f.message)));
	assert.ok(warnings(plan("- no external dependencies — check: `grep -n require lib/slug.js`")).some((f) => /grep/.test(f.message)));
	assert.ok(warnings(plan("- ok — check: `npm test`", "1. write it")).some((f) => /check:/.test(f.message)));
});

test("lint: placeholders in either mode; without Ralph a Done when item needs no command", () => {
	assert.ok(errors(plan("- it works", "1. TODO — check: later"), false).some((f) => /placeholder/i.test(f.message)));
	assert.ok(errors(plan("- handle edge cases"), false).some((f) => /placeholder/i.test(f.message)));
	assert.deepEqual(errors(plan("- the operator sees the page"), false), []);
});

test("the retry message quotes the lines and asks for the same form", () => {
	const text = plan("- npm test passes — check: `npm test | tail -1; echo $?`");
	const m = lintRetryMessage(lintPlan(text, { checks: true }));
	assert.match(m, /npm test \| tail -1/);
	assert.match(m, /DONE WHEN/);
});

test("NERD_PLAN_LINT=0 turns it off", () => {
	assert.equal(planLintOn({}), true);
	assert.equal(planLintOn({ NERD_PLAN_LINT: "0" }), false);
});
