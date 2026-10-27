// Weakened tests (done-gate.ts, process ticket 067): since the task began — the parent of its
// "Plan" commit — a deleted test file, one renamed out of the runners' sight, or a new
// skip/only/todo marker in a test file fails the gate; moving a test, unskipping one, and
// changing code do not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkProject, isTestFile, SKIP_MARKER, taskBase, testWeakening } from "../src/done-gate.ts";
import { tempDir } from "./tmp.ts";

const TEST = `const t = require("node:test"); const a = require("node:assert");\nt.test("one", () => a.equal(1, 1));\nt.test("two", () => a.equal(2, 2));\n`;

/** A task as the plan step leaves it: the project as given, then the "Plan" commit. */
function task(files: Record<string, string> = { "lib/x.js": "module.exports = 1;\n", "test/x.test.js": TEST }) {
	const d = tempDir("nerd-weak-test-");
	const put = (name: string, text: string) => {
		mkdirSync(join(d, name, ".."), { recursive: true });
		writeFileSync(join(d, name), text);
	};
	for (const [n, t] of Object.entries(files)) put(n, t);
	const g = (...a: string[]) => spawnSync("git", a, { cwd: d, stdio: "pipe", encoding: "utf8" });
	g("init", "-q");
	g("config", "user.name", "t");
	g("config", "user.email", "t@t");
	g("add", "-A");
	g("commit", "-qm", "Project as given");
	const given = g("rev-parse", "HEAD").stdout.trim();
	put("PLAN.md", "# Plan\n");
	g("add", "PLAN.md");
	g("commit", "-qm", "Plan", "--", "PLAN.md");
	const commit = (msg = "work") => {
		g("add", "-A");
		g("commit", "-qm", msg);
	};
	return { d, given, put, commit };
}

test("test files and skip markers as the usual runners know them", () => {
	for (const p of ["test/a.test.js", "tests/visible.rs", "src/x.spec.ts", "__tests__/y.js", "test_calc.py", "pkg/calc_test.py", "a.test.mjs"]) assert.ok(isTestFile(p), p);
	for (const p of ["lib/tax.js", "test/a.test.js.bak", "README.md", "src/testing.js", "tests.md"]) assert.ok(!isTestFile(p), p);
	// A dependency's tests are not the project's (run 0006n committed node_modules: qs, object-inspect skip some of theirs).
	for (const p of ["node_modules/qs/test/stringify.js", "vendor/x/tests/a.rs", "target/debug/build/x/tests/t.rs", ".venv/lib/test_x.py"]) assert.ok(!isTestFile(p), p);
	for (const l of ["test.skip('x', () => {})", "it.only('x')", "describe.skip(", "xit('x'", "fdescribe(", "t.test('x', { skip: true }, f)", "test('x', { todo: 'later' })", "t.skip('why')", "#[ignore]", "@pytest.mark.skip", "pytest.skip('x')"]) {
		assert.ok(SKIP_MARKER.test(l), l);
	}
	for (const l of ["test('skip the header', f)", "const skip = 2;", "it('only digits', f)", "// skipped rows are counted"]) assert.ok(!SKIP_MARKER.test(l), l);
});

test("the task's start is the parent of its Plan commit; none without one", async () => {
	const t = task();
	assert.equal(await taskBase(t.d), t.given);
	assert.equal(await taskBase(tempDir("nerd-weak-nogit-")), undefined);
});

test("a skip marker added to a test file is weakening; one taken away is not", async () => {
	const t = task();
	t.put("test/x.test.js", TEST.replace('t.test("two"', 't.test.skip("two"'));
	t.commit();
	const found = await testWeakening(t.d, t.given);
	assert.equal(found.length, 1);
	assert.match(found[0], /test\/x\.test\.js gained a skip\/only\/todo marker: `t\.test\.skip\("two"/);

	const u = task({ "test/x.test.js": TEST.replace('t.test("two"', 't.test.skip("two"') });
	u.put("test/x.test.js", TEST);
	u.commit();
	assert.deepEqual(await testWeakening(u.d, u.given), []);
});

test("a deleted test file, or one renamed away from the runner, is weakening; a moved one is not", async () => {
	const del = task();
	unlinkSync(join(del.d, "test/x.test.js"));
	del.commit();
	assert.deepEqual(await testWeakening(del.d, del.given), ["test/x.test.js was deleted"]);

	const away = task();
	renameSync(join(away.d, "test/x.test.js"), join(away.d, "test/x.test.js.bak"));
	away.commit();
	assert.deepEqual(await testWeakening(away.d, away.given), ["test/x.test.js was renamed to test/x.test.js.bak, which no test runner finds"]);

	const moved = task();
	mkdirSync(join(moved.d, "tests"));
	renameSync(join(moved.d, "test/x.test.js"), join(moved.d, "tests/x.test.js"));
	moved.commit();
	assert.deepEqual(await testWeakening(moved.d, moved.given), []);
});

test("code changes and new tests are not weakening", async () => {
	const t = task();
	t.put("lib/x.js", "module.exports = 2;\n");
	t.put("test/y.test.js", TEST);
	t.commit();
	assert.deepEqual(await testWeakening(t.d, t.given), []);
});

test("the gate reports weakened tests with the rest, and only when given the task's start", async () => {
	const t = task({ "test/x.test.js": TEST });
	t.put("test/x.test.js", TEST.replace('t.test("one"', 't.test.only("one"'));
	t.commit();
	const r = await checkProject(t.d, [], await taskBase(t.d));
	assert.ok(r.failures.some((f) => /Tests were weakened since the task began:[\s\S]*gained a skip\/only\/todo marker[\s\S]*does not count as done/.test(f)));
	assert.ok(!(await checkProject(t.d, [])).failures.some((f) => /weakened/.test(f)));
});
