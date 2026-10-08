// The Ralph loop (decision 0014, ticket 060 of the process): DONE WHEN parsing,
// the frozen plan, the checks in a clean clone, the round decisions, and the
// headless driver with a scripted session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changedItems, frozenPlan, parseDoneWhen, runDoneWhen } from "../src/done-when.ts";
import { planStepPrompt } from "../src/plan-step.ts";
import { checkRound, decide, newState, type RoundCheck, ralphOptions, runRalphHeadless } from "../src/ralph.ts";
import { tempDir } from "./tmp.ts";

function repo(files: Record<string, string>, message = "work"): string {
	const d = tempDir("nerd-ralph-test-");
	git(d, "init", "-q");
	git(d, "config", "user.name", "t");
	git(d, "config", "user.email", "t@t");
	commit(d, files, message);
	return d;
}

function git(d: string, ...a: string[]) {
	return spawnSync("git", a, { cwd: d, stdio: "pipe", encoding: "utf8" });
}

function commit(d: string, files: Record<string, string>, message: string) {
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(d, name, ".."), { recursive: true });
		writeFileSync(join(d, name), text);
	}
	git(d, "add", "-A");
	git(d, "commit", "-qm", message);
}

const PLAN = `# Plan

## Steps
1. do it

## Done when
- the file exists — check: \`test -f out.txt\`
- the answer is 42 — check: \`grep -q 42 out.txt\`
- it is pretty
`;

test("parseDoneWhen: claims with and without a check command", () => {
	const items = parseDoneWhen(PLAN);
	assert.deepEqual(items, [
		{ claim: "the file exists", cmd: "test -f out.txt" },
		{ claim: "the answer is 42", cmd: "grep -q 42 out.txt" },
		{ claim: "it is pretty" },
	]);
	assert.deepEqual(parseDoneWhen("no section here"), []);
	assert.deepEqual(parseDoneWhen("DONE WHEN\n- x — check: `true`\nPLAN\n- y"), [{ claim: "x", cmd: "true" }]);
});

test("the plan form asks for check commands only with the Ralph loop", () => {
	assert.match(planStepPrompt(true), /check: `<a shell command/);
	assert.doesNotMatch(planStepPrompt(false), /check: `/);
});

test("runDoneWhen: a passing, a failing and an item without a command", async () => {
	const d = repo({ "out.txt": "41\n" });
	const r = await runDoneWhen(d, parseDoneWhen(PLAN));
	assert.deepEqual(
		r.map((x) => x.ok),
		[true, false, false],
	);
	assert.match(r[1].why, /exited with 1/);
	assert.match(r[2].why, /^no check/);
});

test("the checks are the plan as committed; a later edit is reported, not run", async () => {
	const d = repo({ "PLAN.md": PLAN }, "Plan");
	commit(d, { "PLAN.md": PLAN.replace("grep -q 42 out.txt", "true"), "out.txt": "41\n" }, "work");
	const frozen = parseDoneWhen((await frozenPlan(d)) ?? "");
	assert.equal(frozen[1].cmd, "grep -q 42 out.txt");
	const st = newState();
	const c = await checkRound(d, st);
	assert.ok(c.planned);
	assert.ok(c.failures.some((f) => f.includes("grep -q 42 out.txt")), "the frozen check ran and failed");
	assert.ok(c.notes.some((n) => /differs from the plan as committed/.test(n)));
	assert.equal(changedItems(frozen, parseDoneWhen(PLAN.replace("grep -q 42 out.txt", "true"))).length, 1);
});

test("a check that passes after its own file changed is reported", async () => {
	const plan = "## Done when\n- strong bots — check: `sh check.sh`\n";
	const d = repo({ "PLAN.md": plan }, "Plan");
	commit(d, { "check.sh": "exit 1\n" }, "work");
	const st = newState();
	const c1 = await checkRound(d, st);
	assert.ok(c1.failures.some((f) => f.includes("strong bots")));
	commit(d, { "check.sh": "exit 0\n" }, "weaken");
	const c2 = await checkRound(d, st);
	assert.ok(!c2.failures.some((f) => f.includes("strong bots")));
	assert.ok(c2.notes.some((n) => /after its check's own files changed .*check\.sh/.test(n)));
});

const fail = (f: string[]): RoundCheck => ({ failures: f, items: [], notes: [], planned: true });

test("decide: a failing round starts the next one with the failures and the task", () => {
	const st = newState(0);
	const d = decide(st, fail(["Done when \"x\": exited with 1"]), "build x", undefined, { maxRounds: 3, maxMs: 0 }, 1);
	assert.equal(d.kind, "next");
	assert.equal(st.round, 1);
	if (d.kind === "next") {
		assert.match(d.message, /\[ralph round 1\/3\]/);
		assert.match(d.message, /build x/);
		assert.match(d.message, /- Done when "x": exited with 1/);
		assert.match(d.message, /not by weakening the check/);
	}
});

test("decide: the same failures twice stop the loop (no progress)", () => {
	const st = newState(0);
	decide(st, fail(["a", "b"]), "t", undefined, { maxRounds: 5, maxMs: 0 }, 1);
	const d = decide(st, fail(["b", "a"]), "t", undefined, { maxRounds: 5, maxMs: 0 }, 2);
	assert.equal(d.kind, "stop");
	if (d.kind === "stop") assert.match(d.report, /no progress/);
});

test("decide: the budget of rounds and of minutes", () => {
	const st = newState(0);
	decide(st, fail(["a"]), "t", undefined, { maxRounds: 1, maxMs: 0 }, 1);
	const d = decide(st, fail(["b"]), "t", undefined, { maxRounds: 1, maxMs: 0 }, 2);
	assert.equal(d.kind, "stop");
	if (d.kind === "stop") assert.match(d.report, /1 round\(s\) used/);
	const t = decide(newState(0), fail(["a"]), "t", undefined, { maxRounds: 9, maxMs: 60_000 }, 61_000);
	assert.equal(t.kind, "stop");
	if (t.kind === "stop") assert.match(t.report, /1 min used/);
});

test("decide: all checks pass", () => {
	const d = decide(newState(0), { failures: [], items: [{ claim: "x", cmd: "true", ok: true, why: "" }], notes: [], planned: true }, "t", undefined, { maxRounds: 3, maxMs: 0 });
	assert.equal(d.kind, "done");
});

test("runRalphHeadless: a failing round is compacted, then prompted with its failures; then done", async () => {
	const calls: string[] = [];
	const session = {
		compact: async () => {
			calls.push("compact");
		},
		prompt: async (text: string) => {
			calls.push(`prompt:${text.split("\n")[0]}`);
			assert.match(text, /- gate: npm test failed/);
		},
	};
	let n = 0;
	const check = async (): Promise<RoundCheck> => (n++ === 0 ? fail(["gate: npm test failed"]) : fail([]));
	const rounds: string[] = [];
	const d = await runRalphHeadless(session, "/nowhere", "the task", { maxRounds: 3, maxMs: 0 }, (r) => rounds.push(r.kind), check);
	assert.equal(d.kind, "done");
	assert.deepEqual(calls, ["compact", "prompt:[ralph round 1/3] A new round of the same task. The conversation before it was compacted; what counts is in the files: the code, PLAN.md (its Done when items are the checks), notes/, git log."]);
	assert.deepEqual(rounds, ["next", "done"]);
});

test("ralphOptions: defaults and settings", () => {
	assert.deepEqual(ralphOptions({}), { maxRounds: 3, maxMs: 0 });
	assert.deepEqual(ralphOptions({ NERD_RALPH_ROUNDS: "5", NERD_RALPH_MINUTES: "90" }), { maxRounds: 5, maxMs: 5_400_000 });
});

test("the TUI loop: settled after work → compaction → a new turn with the failures; then the report", async () => {
	const d = repo({ "a.txt": "1\n" });
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const sent: { content: string; trigger: boolean }[] = [];
	let compacted = 0;
	const pi = {
		on: (name: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
		sendMessage: (m: { content: string }, o?: { triggerTurn?: boolean }) => sent.push({ content: m.content, trigger: !!o?.triggerTurn }),
	};
	const ctx = {
		cwd: d,
		sessionManager: { getBranch: () => [] },
		compact: (o: { onComplete: () => void }) => {
			compacted++;
			o.onComplete();
		},
	};
	let n = 0;
	const { ralph } = await import("../src/ralph.ts");
	ralph(pi as never, { maxRounds: 3, maxMs: 0 }, async () => (n++ === 0 ? fail(["x failed"]) : fail([])));
	const turn = async (prompt: string) => {
		await handlers.get("before_agent_start")?.({ prompt }, ctx);
		await handlers.get("tool_result")?.({ toolName: "write", isError: false }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
	};
	await turn("make x");
	assert.equal(compacted, 1);
	assert.equal(sent.length, 1);
	assert.ok(sent[0].trigger);
	assert.match(sent[0].content, /\[ralph round 1\/3\][\s\S]*make x[\s\S]*- x failed/);
	await turn(""); // the round's own turn (a custom message, no operator prompt)
	assert.equal(sent.length, 2);
	assert.ok(!sent[1].trigger);
	assert.match(sent[1].content, /^\[ralph\] Done after 1 round/);
	// A turn that changed nothing does not check.
	await handlers.get("before_agent_start")?.({ prompt: "what is x?" }, ctx);
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(sent.length, 2);
});

test("checkQuotes: a quoted web fact must be in its saved page word for word", async () => {
	const { checkQuotes } = await import("../src/done-when.ts");
	const d = repo({
		"notes/web/en-wikipedia-org-wiki-wuxing.md": "URL: https://en.wikipedia.org/wiki/Wuxing\n\nWood feeds Fire, Fire creates Earth.\n",
		"README.md": [
			'> "Wood feeds Fire" — notes/web/en-wikipedia-org-wiki-wuxing.md',
			'> "Water feeds Fire" — notes/web/en-wikipedia-org-wiki-wuxing.md',
			'> "Metal chops Wood" — notes/web/missing.md',
			"> an ordinary quote, not a web fact",
		].join("\n"),
	});
	const f = checkQuotes(d);
	assert.equal(f.length, 2);
	assert.match(f[0], /"Water feeds Fire".*does not say it word for word/);
	assert.match(f[1], /notes\/web\/missing\.md, which is not in the commit/);
	const r = await runDoneWhen(d, []);
	assert.equal(r.filter((x) => !x.ok).length, 2, "runDoneWhen reports them as failing items");
});

test("checkedReport: built from the harness's runs, not the model's words", async () => {
	const { checkedReport } = await import("../src/ralph.ts");
	const s = checkedReport({
		failures: [],
		notes: [],
		planned: true,
		head: "0123456789abcdef",
		items: [
			{ claim: "tests pass", cmd: "npm test", ok: true, why: "", rc: 0 },
			{ claim: "hard bot wins", cmd: "node sim.js", ok: false, why: "exited with 1", rc: 1 },
			{ claim: "it is pretty", ok: false, why: "no check: the plan gives no command for this item" },
		],
	});
	assert.match(s, /on commit 0123456/);
	assert.match(s, /✓ tests pass — `npm test` exit 0/);
	assert.match(s, /✗ hard bot wins — `node sim.js` exit 1: not demonstrated/);
	assert.match(s, /✗ it is pretty — not demonstrated \(no check/);
});

test("unfailable: checks that pass whatever the project does", async () => {
	const { unfailable } = await import("../src/done-when.ts");
	for (const c of [
		"npm test || true",
		"node sim.js; exit 0",
		"grep -q 42 out.txt && echo PASS || echo FAIL",
		"node check.js || echo skip",
		"npm test; echo done",
		`node -e "console.assert(1 === 2)"`,
		"node sim.js | tee log; test $? -eq 0",
	]) assert.ok(unfailable(c), c);
	for (const c of [
		"npm test",
		"grep -q 42 out.txt",
		"node sim.js --games 200 && test -f report.json",
		`node -e "const a = require('assert'); a.equal(1, 1)"`,
		"browse http://localhost:8000 | grep -q 'Wood feeds Fire'",
	]) assert.equal(unfailable(c), undefined, c);
	const d = repo({ "out.txt": "41\n" });
	const r = await runDoneWhen(d, [{ claim: "is 42", cmd: "grep -q 42 out.txt || true" }]);
	assert.equal(r[0].ok, false);
	assert.match(r[0].why, /cannot fail/);
});

test("parseDoneWhen: commands with words around them, as the model wrote them on the stand", () => {
	const items = parseDoneWhen(`## Done when
- \`npm test\` passes all tests and exits 0. — check: \`cd /workspace && npm test\` → exit 0.
- All tests pass — check: run \`npm test\` from project root
- Nothing under \`test/\` was modified — check: \`git -C /workspace diff --name-only -- test/ | wc -l\` is 0
`);
	assert.deepEqual(
		items.map((i) => i.cmd),
		["cd /workspace && npm test", "npm test", "git -C /workspace diff --name-only -- test/ | wc -l"],
	);
	assert.equal(items[0].claim, "`npm test` passes all tests and exits 0.");
});

test("a check that names a directory does not break the round (EISDIR on the stand)", async () => {
	const plan = "## Done when\n- tests untouched — check: `test -d test/`\n";
	const d = repo({ "PLAN.md": plan, "test/a.test.js": "" }, "Plan");
	const c = await checkRound(d, newState());
	assert.ok(!c.failures.some((f) => f.includes("tests untouched")));
});
