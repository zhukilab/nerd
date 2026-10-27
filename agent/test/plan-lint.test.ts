// plan-lint (ticket 065 of the process): the harness checks PLAN.md after the
// plan step, before the plan is frozen. The fixtures are the Done when lines of
// plans models wrote on the stand of ticket 060 (2026-10-09), where every Ralph
// stop came from a check the frozen plan could not fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDoneWhen, syntaxError, unfailable } from "../src/done-when.ts";
import { callNumbers, exercisesBehavior, hasOwnInput, highestThreshold, lintPlan, lintRetryMessage, planLintOn } from "../src/plan-lint.ts";

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

// Ticket 080: semver-pair-1's Done when, all four checks pass on a wrong compare().
test("lint: a Done when with no check of behavior is an error", () => {
	const semver1 = plan(
		[
			"- semver.js exports parse, compare, sort — check: `node -e \"import('./semver.js').then(m=>{if(!m.parse||!m.compare||!m.sort)process.exit(1)})\"`",
			"- package.json has type module and test script — check: `grep -q '\"type\": \"module\"' package.json`",
			"- test file exists — check: `test -f test/semver.test.js`",
			"- npm test exits 0 — check: `npm test`",
		].join("\n"),
	);
	assert.ok(errors(semver1).some((f) => /concrete input/.test(f.message)));
	assert.ok(errors(plan("- tests pass — check: `npm test`")).some((f) => /concrete input/.test(f.message)));
	const typeofOnly = "- exports — check: `node -e \"import('./lib/slug.js').then(m=>process.exit(typeof m.slugify==='function'?0:1))\"`";
	assert.ok(errors(plan(typeofOnly)).some((f) => /concrete input/.test(f.message)));
});

test("lint: what counts as a behavior check", () => {
	const ok = [
		"node -e \"import('./lib/allocate.js').then(m=>process.exit(JSON.stringify(m.allocate(3,[0.3,0.1,0.2]))==='[2,0,1]'?0:1))\"",
		"node -e 'import(\"./semver.js\").then(m=>{try{m.parse(\"1.2\")}catch{process.exit(0)}process.exit(1)})'",
		"node --input-type=module -e \"import {slugify} from './lib/slug.js'; process.exit(slugify('Łódź')==='lodz'?0:1)\"",
		"python3 -c 'import m; assert m.f(2) == 4'",
		"node scripts/check-slug.mjs",
		"node - <<'EOF' > /dev/null 2>&1 || echo FAIL",
		"curl -sf http://localhost:3000/api/health | grep -q ok",
	];
	for (const c of ok) assert.ok(exercisesBehavior(c), c);
	const no = ["npm test", "node --test", "node --check lib/x.js", "test -f a.js", "grep -q x a.js", "node -e \"import('./a.js').then(m=>process.exit(typeof m.f==='function'?0:1))\""];
	for (const c of no) assert.ok(!exercisesBehavior(c), c);
});

// Ticket 083: the rule in the plan, the check only on the task's own example.
test("lint with ownInput: behavior checks only on the task's examples are an error", () => {
	const task = "# Plan\n\n## Task\n\n> allocate(total, ratios): e.g. allocate(3, [0.3, 0.1, 0.2]) returns [2, 0, 1]; allocate(100, [1, 1, 1]) returns [34, 33, 33].\n\n## Steps\n1. write it — check: `npm test`\n\n## Done when\n";
	const example = "- example — check: `node -e \"import('./lib/allocate.js').then(m=>process.exit(JSON.stringify(m.allocate(3,[0.3,0.1,0.2]))==='[2,0,1]'?0:1))\"`\n- tests — check: `npm test`\n";
	const own = `${example}- different decimals — check: \`node -e "import('./lib/allocate.js').then(m=>process.exit(JSON.stringify(m.allocate(10,[3.3,0,1]))==='[8,0,2]'?0:1))"\`\n`;
	const flagged = (t: string) => lintPlan(t, { checks: true, ownInput: true }).some((f) => /only the task's own examples/.test(f.message));
	assert.ok(flagged(task + example));
	assert.ok(!flagged(task + own));
	assert.ok(!lintPlan(task + example, { checks: true }).some((f) => /own examples/.test(f.message)), "off unless asked");
	assert.ok(hasOwnInput("node -e \"import('./s.js').then(m=>process.exit(m.slugify('ŁÓDŹ')==='lodz'?0:1))\"", "slugify('Hello World') returns 'hello-world'"));
	assert.ok(!hasOwnInput("node -e \"import('./s.js').then(m=>process.exit(m.slugify('Hello World')==='hello-world'?0:1))\"", "slugify('Hello World') returns 'hello-world'"));
});

// Ticket 087: semver-pair-2's two checks, the JSON quotes closing the shell string.
test("syntaxError: a quote inside the node program that closes the shell string", () => {
	const split = `node -e "import { sort } from './semver.js'; const s = sort(['1.0.0', '0.9.0']); process.exit(JSON.stringify(s) === '["0.9.0","1.0.0"]' ? 0 : 1)"`;
	assert.match(syntaxError(split) ?? "", /closes the shell's double-quoted string/);
	const escaped = `node --input-type=module -e "import { sort } from './semver.js'; process.exit(JSON.stringify(sort(['1.0.0'])) === '[\\"1.0.0\\"]' ? 0 : 1)"`;
	assert.equal(syntaxError(escaped), undefined);
	assert.equal(syntaxError(`node -e "process.exit(1+1===2?0:1)" && npm test`), undefined);
	assert.equal(syntaxError(`(node -e 'process.exit(0)')`), undefined);
	assert.match(syntaxError(`node -e 'const s='abc'; process.exit(s==="abc"?0:1)'`) ?? "", /single-quoted/);
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

// Process ticket 089: `npm test | grep -q "2 tests passed"`; the model rewrote scripts.test to echo it.
test("plan-lint: a check that reads the test runner's printed text is an error", () => {
	const behave = "- f works — check: `node -e \"import('./x.js').then(m=>process.exit(m.f(1)===2?0:1))\"`";
	for (const cmd of ['npm test | grep -q "2 tests passed"', "node --test 2>&1 | tail -1 | grep -q 'fail 0'", "npm run test | wc -l", "cargo test 2>&1 | grep -q 'test result: ok'"]) {
		const e = errors(plan(`- tests pass — check: \`${cmd}\`\n${behave}`));
		assert.ok(e.some((f) => /text the test runner prints/.test(f.message)), cmd);
	}
	for (const cmd of ["npm test", "npm test && node check.js", "node --test test/a.test.js"]) {
		const e = errors(plan(`- tests pass — check: \`${cmd}\`\n${behave}`));
		assert.ok(!e.some((f) => /text the test runner prints/.test(f.message)), cmd);
	}
});

// Process ticket 089: "5% of taxable + 4% on the part over 1 107 750" read as a band; no check past it.
test("plan-lint: no behavior check above the task's highest threshold is an error", () => {
	assert.equal(highestThreshold("4% on the part of taxable over 1 107 750; 20% above 37,700"), 1107750);
	assert.equal(highestThreshold("a slug of more than 50 characters is cut"), undefined, "counts and lengths are not amounts");
	assert.deepEqual(callNumbers("node -e \"import('./t.js').then(m=>process.exit(m.f('X', 3_000_000).a===1?0:1))\""), [3000000, 1, 0, 1]);
	const withTask = (done: string) =>
		`# Plan\n\n## Task\n\n> incomeTax = 5% of taxable + 4% on the part of taxable over 1 107 750.\n\n## Steps\n1. write it — check: \`npm test\`\n\n## Done when\n${done}\n`;
	const at = (g: string) => `- tax — check: \`node -e "import('./t.js').then(m=>process.exit(m.tax(${g})===1?0:1))"\``;
	assert.ok(errors(withTask(at("50000"))).some((f) => /highest threshold \(1107750\)/.test(f.message)));
	assert.ok(!errors(withTask(`${at("50000")}\n${at("3_000_000")}`)).some((f) => /highest threshold/.test(f.message)));
	assert.ok(!errors(plan(at("5"))).some((f) => /highest threshold/.test(f.message)), "no threshold in the task: no finding");
});

// Process ticket 090: Rust. A library's behavior check is nerd-rs-eval (container/nerd-rs-eval.mjs),
// a binary's is cargo run with arguments or an input; cargo test alone is the work's own tests.
test("plan-lint, Rust: what counts as a behavior check", () => {
	const ok = [
		"nerd-rs-eval 'assert_eq!(to_roman(4), \"IV\");'",
		"nerd-rs-eval -C . 'let mut inv = Inventory::new(); inv.add(\"a\", 3); assert_eq!(inv.count(\"a\"), 3);'",
		"cargo run -q -- 1 2 3 | grep -qx 2",
		"printf '3\\n1\\n2\\n' | cargo run -q --bin stats -- --median | grep -qx 2",
		"./target/debug/stats --mean < data.txt",
	];
	for (const c of ok) assert.ok(exercisesBehavior(c), c);
	const no = ["cargo test", "cargo build", "cargo test --test visible", "cargo run", "nerd-rs-eval 'let _ = Inventory::new(); std::process::exit(0);'"];
	for (const c of no) assert.ok(!exercisesBehavior(c), c);
	assert.deepEqual(callNumbers("nerd-rs-eval 'assert_eq!(tax(\"US-MA\", 2_000_000.0), 135114.0);'"), [2000000]);
	assert.deepEqual(callNumbers("cargo run -q -- 3000000 7 | grep -qx 5"), [3000000, 7]);
});

test("plan-lint, Rust: the hint names nerd-rs-eval for a Rust project", () => {
	const e = lintPlan(plan("- tests pass — check: `cargo test`"), { checks: true, rust: true }).find((f) => /concrete input/.test(f.message));
	assert.match(e?.message ?? "", /nerd-rs-eval 'assert_eq!/);
	const js = lintPlan(plan("- tests pass — check: `npm test`"), { checks: true }).find((f) => /concrete input/.test(f.message));
	assert.doesNotMatch(js?.message ?? "", /nerd-rs-eval/);
});

test("done when, Rust: a bare cargo command is read; nerd-rs-eval that only prints cannot fail; a split quote", () => {
	assert.deepEqual(parseDoneWhen("## Done when\n- runs — check: cargo run -q -- 4 | grep -qx IV\n"), [{ claim: "runs", cmd: "cargo run -q -- 4 | grep -qx IV" }]);
	assert.match(unfailable("nerd-rs-eval 'println!(\"{}\", to_roman(4));'") ?? "", /only prints/);
	assert.equal(unfailable("nerd-rs-eval 'assert_eq!(to_roman(4), \"IV\");'"), undefined);
	assert.match(syntaxError(`nerd-rs-eval "assert_eq!(to_roman(4), "IV");"`) ?? "", /closes the shell's double-quoted string/);
	assert.equal(syntaxError(`nerd-rs-eval 'assert_eq!(to_roman(4), "IV");'`), undefined);
});

// Process ticket 093: false findings on the Rust plans of the small-task run.
test("plan-lint, Rust: todo! is not a placeholder; a built binary without ./ is a run; $? of a substitution is fine", () => {
	const todo = plan("- f — check: `nerd-rs-eval 'assert_eq!(f(1), 2);'`", "1. replace the two `todo!` stubs in src/lib.rs — check: `cargo test`");
	assert.ok(!errors(todo).some((f) => /placeholder/.test(f.message)), "todo! is Rust's macro");
	assert.ok(errors(plan("- f — check: `nerd-rs-eval 'assert_eq!(f(1), 2);'`", "1. TODO later — check: `cargo test`")).some((f) => /placeholder/.test(f.message)));
	assert.ok(exercisesBehavior("cargo build -q && o=$(printf '1\\n2\\n' | target/debug/stats 2>/dev/null) && [ \"$o\" = 'count 2' ]"));
	assert.equal(unfailable("cargo build -q && o=$(printf '1\\n' | target/debug/stats) && ec=$? && [ $ec -eq 0 ]"), undefined);
	assert.match(unfailable("printf '1\\n' | cargo run -q | tail -1; [ $? -eq 0 ]") ?? "", /reads \$\? after a pipe/);
	const runner = lintPlan(plan("- tests — check: `cargo test --quiet 2>&1 | grep -q 'test result: ok'`\n- f — check: `nerd-rs-eval 'assert_eq!(f(1), 2);'`"), { checks: true, rust: true });
	assert.match(runner.find((f) => /test runner prints/.test(f.message))?.message ?? "", /Use `cargo test` alone/);
});
