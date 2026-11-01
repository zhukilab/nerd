// The Ralph loop (decision 0014, ticket 060 of the process): DONE WHEN parsing,
// the frozen plan, the checks in a clean clone, the round decisions, and the
// headless driver with a scripted session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BARE_CLAIM, changedItems, frozenPlan, parseDoneWhen, runDoneWhen } from "../src/done-when.ts";
import { checksOn, planStepPrompt, rustTask } from "../src/plan-step.ts";
import { checkRound, decide, newState, type RoundCheck, ralphOn, ralphOptions, runRalphHeadless } from "../src/ralph.ts";
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
	// Process ticket 090: a Rust task gets the Rust way to check behaviour.
	assert.match(planStepPrompt(true, true), /nerd-rs-eval 'assert_eq!\(f\("in"\), "out"\);'/);
	assert.doesNotMatch(planStepPrompt(true, false), /nerd-rs-eval/);
	assert.doesNotMatch(planStepPrompt(false, true), /nerd-rs-eval/);
	assert.equal(rustTask("/nonexistent", "Write a Rust crate that…"), true);
	assert.equal(rustTask("/nonexistent", "Write a node library"), false);
});

test("the Ralph loop and its plan form are on by default; NERD_RALPH=0 turns both off (process ticket 060)", () => {
	assert.equal(ralphOn({}), true);
	assert.equal(checksOn({}), true);
	assert.equal(ralphOn({ NERD_RALPH: "1" }), true);
	assert.equal(ralphOn({ NERD_RALPH: "0" }), false);
	assert.equal(checksOn({ NERD_RALPH: "0" }), false);
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

// Process ticket 090: a Rust binary's checks in the clean clone; one that reads stdin does not hang.
test("runDoneWhen, Rust: cargo run with arguments, and a binary reading stdin gets an empty one", { skip: spawnSync("sh", ["-c", "command -v cargo"]).status !== 0 && "cargo not on PATH" }, async () => {
	process.env.XDG_CACHE_HOME = tempDir("nerd-ralph-cache-");
	const d = repo({
		"Cargo.toml": '[package]\nname = "echo2"\nversion = "0.1.0"\nedition = "2021"\n',
		".gitignore": "/target\n",
		"src/main.rs":
			'use std::io::Read;\nfn main() { let a: Vec<String> = std::env::args().skip(1).collect(); if a.is_empty() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); print!("[{}]", s.trim()); } else { println!("{}", a.join("+")); } }\n',
	});
	const r = await runDoneWhen(
		d,
		[
			{ claim: "args", cmd: "cargo run -q -- 1 2 | grep -qx '1+2'" },
			{ claim: "stdin", cmd: "cargo run -q | grep -qx '\\[\\]'" },
			{ claim: "wrong", cmd: "cargo run -q -- 3 | grep -qx 4" },
			// Process ticket 093: rs-stats-2's form; with CARGO_TARGET_DIR the binary was not there (127).
			{ claim: "built binary", cmd: "cargo build -q && target/debug/echo2 5 6 | grep -qx '5+6'" },
		],
		60_000,
	);
	assert.deepEqual(
		r.map((x) => x.ok),
		[true, true, false, true],
		r.map((x) => x.why).join("\n"),
	);
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

test("a second task in the same workspace is checked against its own plan, not the first one's", async () => {
	// Process ticket 102: the first task's plan added PLAN.md; the second's only changed it.
	const first = "## Done when\n- hello says ready — check: `./hello.sh | grep -q ready`\n";
	const d = repo({ "PLAN.md": first, "hello.sh": "#!/bin/sh\necho ready\n" }, "Plan");
	commit(d, { "PLAN.md": PLAN }, "Plan");
	commit(d, { "PLAN.md": PLAN.replace("grep -q 42 out.txt", "true"), "out.txt": "41\n" }, "work");
	const frozen = parseDoneWhen((await frozenPlan(d)) ?? "");
	assert.equal(frozen[1].cmd, "grep -q 42 out.txt");
	assert.ok(!frozen.some((i) => i.cmd?.includes("hello.sh")));
	// Without a "Plan" commit: the latest addition of PLAN.md.
	const h = repo({ "PLAN.md": first }, "init");
	commit(h, { "PLAN.md": PLAN }, "edit");
	assert.equal(parseDoneWhen((await frozenPlan(h)) ?? "")[0].cmd, "./hello.sh | grep -q ready");
});

test("no claim of PLAN.md among the committed ones: a warning first, not an edit note", async () => {
	const d = repo({ "PLAN.md": PLAN }, "Plan");
	commit(d, { "PLAN.md": "## Done when\n- the reply is the marker — check: `true`\n" }, "work");
	const c = await checkRound(d, newState());
	assert.match(c.notes[0], /^WARNING: none of PLAN\.md's Done when claims/);
	assert.ok(!c.notes.some((n) => /differs from the plan as committed/.test(n)));
	const edit = repo({ "PLAN.md": PLAN }, "Plan");
	commit(edit, { "PLAN.md": PLAN.replace("grep -q 42 out.txt", "true") }, "work");
	assert.ok(!(await checkRound(edit, newState())).notes.some((n) => /WARNING/.test(n)));
});

test("an unusable check is not a reason for a round, and is reported as not demonstrated", async () => {
	// The stops of the 060 stand: the plan is frozen, so such a check can never be fixed.
	const plan = "## Done when\n- the file exists — check: `test -f out.txt`\n- nothing changed — check: `git diff -- test/`\n- it is pretty\n";
	const d = repo({ "PLAN.md": plan }, "Plan");
	commit(d, { "out.txt": "x\n" }, "work");
	const c = await checkRound(d, newState());
	assert.ok(!c.failures.some((f) => /nothing changed|it is pretty/.test(f)), c.failures.join("\n"));
	assert.ok(c.notes.some((n) => /unusable/.test(n) && /nothing changed/.test(n) && /it is pretty/.test(n)));
	assert.deepEqual(
		c.items.map((i) => [i.ok, !!i.unusable]),
		[
			[true, false],
			[false, true],
			[false, true],
		],
	);
	const done = decide(newState(), c, "t", undefined, { maxRounds: 3, maxMs: 0 });
	assert.equal(done.kind, c.failures.length ? "next" : "done");
	if (done.kind === "done") assert.match(done.report, /1 of 3 Done when checks .* not demonstrated/);
});

test("a check whose node script does not parse is unusable, not run", async () => {
	const d = repo({ "PLAN.md": "## Done when\n- compare — check: `node -e 'process.exit(1));'`\n" }, "Plan");
	const r = await runDoneWhen(d, parseDoneWhen("## Done when\n- compare — check: `node -e 'process.exit(1));'`\n"));
	assert.equal(r[0].unusable, true);
	assert.match(r[0].why, /broken: its node script does not parse/);
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
		assert.match(d.message, /The task outranks the checks/);
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

test("decide: tests pass but the same checks fail twice — one amend round, then the stop", () => {
	const opts = { maxRounds: 3, maxMs: 0 };
	const items = [{ claim: "sorted", cmd: "node s.js", ok: false, why: "exited with 1", rc: 1 }];
	const c = (): RoundCheck => ({ failures: ['Done when "sorted" — `node s.js`: exited with 1'], gate: [], items, notes: [], planned: true });
	const st = newState(0);
	assert.equal(decide(st, c(), "t", undefined, opts, 1).kind, "next");
	const a = decide(st, c(), "sort it", undefined, opts, 2);
	assert.equal(a.kind, "next");
	if (a.kind === "next") {
		assert.match(a.message, /tests and the gate pass/);
		assert.match(a.message, /keep the claim's words exactly and change only the command/);
		assert.match(a.message, /sort it/);
	}
	assert.deepEqual([...(st.amendable ?? [])], ["sorted"]);
	assert.equal(decide(st, c(), "t", undefined, opts, 3).kind, "stop", "once per task");
	// the gate failing, or no round left: no amend round
	const g = newState(0);
	const cg = (): RoundCheck => ({ ...c(), gate: ["npm test failed"], failures: ["npm test failed", ...c().failures] });
	decide(g, cg(), "t", undefined, opts, 1);
	assert.equal(decide(g, cg(), "t", undefined, opts, 2).kind, "stop");
	const b = newState(0);
	decide(b, c(), "t", undefined, { maxRounds: 1, maxMs: 0 }, 1);
	assert.equal(decide(b, c(), "t", undefined, { maxRounds: 1, maxMs: 0 }, 2).kind, "stop");
});

test("checkRound: a command corrected in the amend round replaces the frozen one; others stay frozen", async () => {
	const plan = "## Done when\n- tests pass — check: `grep -q passing out.txt`\n- the file exists — check: `test -f out.txt`\n";
	const d = repo({ "PLAN.md": plan }, "Plan");
	commit(d, { "out.txt": "# pass 3\n" }, "work");
	const st = newState();
	assert.ok((await checkRound(d, st)).failures.some((f) => f.includes("grep -q passing")));
	st.amendable = new Set(["tests pass"]);
	const fixed = plan.replace("grep -q passing out.txt", "grep -q '# pass' out.txt").replace("test -f out.txt", "true");
	commit(d, { "PLAN.md": fixed }, "amend check");
	const c = await checkRound(d, st);
	assert.deepEqual(c.failures, []);
	assert.equal(c.items[0].cmd, "grep -q '# pass' out.txt");
	assert.equal(c.items[1].cmd, "test -f out.txt", "a claim not offered keeps its frozen command");
	assert.ok(c.notes.some((n) => /corrected by the model .*was `grep -q passing out.txt`, now `grep -q '# pass' out.txt`/.test(n)));
	assert.ok(c.notes.some((n) => /differs from the plan as committed.*the file exists/.test(n)));
	// the offer was for that round only: a later edit is not taken
	commit(d, { "PLAN.md": fixed.replace("grep -q '# pass' out.txt", "true") }, "again");
	assert.equal((await checkRound(d, st)).items[0].cmd, "grep -q '# pass' out.txt");
});

// Ticket 089 of the process: the model fixed a wrong check right after it failed; the edit was
// only reported, and the amend round came a round later quoting the old command.
test("checkRound: a check corrected after it failed is taken at once, on the amend round's terms", async () => {
	const plan = "## Done when\n- tests pass — check: `grep -q passing out.txt`\n";
	const d = repo({ "PLAN.md": plan, "out.txt": "# pass 3\n" }, "work");
	const st = newState(0);
	assert.equal((await checkRound(d, st)).failures.length, 1);
	commit(d, { "PLAN.md": plan.replace("grep -q passing out.txt", "grep -q '# pass' out.txt") }, "fix the check");
	const c = await checkRound(d, st);
	assert.deepEqual(c.failures, []);
	assert.ok(c.items[0].ok);
	assert.ok(c.notes.some((n) => /corrected by the model .*now `grep -q '# pass' out.txt`/.test(n)));
	assert.equal(st.amendUsed, true, "it is the task's one amend");
	// later checks run the corrected command
	assert.equal((await checkRound(d, st)).items[0].cmd, "grep -q '# pass' out.txt");
});

test("checkRound: an early correction is not taken if the check never failed, if it fails itself, or after the amend", async () => {
	const plan = "## Done when\n- tests pass — check: `grep -q passing out.txt`\n";
	// edited before the first check: the committed command has not failed yet
	const d1 = repo({ "PLAN.md": plan, "out.txt": "# pass 3\n" }, "work");
	commit(d1, { "PLAN.md": plan.replace("grep -q passing out.txt", "grep -q '# pass' out.txt") }, "edit early");
	assert.equal((await checkRound(d1, newState(0))).failures.length, 1);
	// the new command fails on this code too
	const d2 = repo({ "PLAN.md": plan, "out.txt": "# pass 3\n" }, "work");
	const st2 = newState(0);
	await checkRound(d2, st2);
	commit(d2, { "PLAN.md": plan.replace("grep -q passing out.txt", "grep -q nothing out.txt") }, "bad fix");
	assert.equal((await checkRound(d2, st2)).failures.length, 1);
	assert.notEqual(st2.amendUsed, true);
	// the amend was used already
	const d3 = repo({ "PLAN.md": plan, "out.txt": "# pass 3\n" }, "work");
	const st3 = newState(0);
	await checkRound(d3, st3);
	st3.amendUsed = true;
	commit(d3, { "PLAN.md": plan.replace("grep -q passing out.txt", "grep -q '# pass' out.txt") }, "fix");
	assert.equal((await checkRound(d3, st3)).failures.length, 1);
});

test("checkRound with the amend guard: an early correction must pass on the first 'done' too", async () => {
	const plan = "## Done when\n- has four — check: `grep -q seven out.txt`\n";
	const d = repo({ "PLAN.md": plan, "out.txt": "one two\n" }, "work");
	const st = newState(0, { amendGuard: true });
	await checkRound(d, st);
	commit(d, { "out.txt": "one two four\n" }, "fit");
	commit(d, { "PLAN.md": plan.replace("grep -q seven out.txt", "grep -q four out.txt") }, "fix check");
	const c = await checkRound(d, st);
	assert.equal(c.failures.length, 1);
	assert.ok(c.notes.some((n) => /corrected check was not taken/.test(n)));
});

test("parseDoneWhen: a section that is a bare command is one check (process ticket 107)", () => {
	// As nemotron-3-nano wrote it on the stand of 106: over lines, and in one pair of backticks.
	const lines = "## Done when\n\nbash -c 'set -e\n./wuxing generates wood fire | grep -q \"^true$\"\n'\n\n## Plan lint\n";
	assert.deepEqual(parseDoneWhen(lines), [{ claim: BARE_CLAIM, cmd: "bash -c 'set -e\n./wuxing generates wood fire | grep -q \"^true$\"\n'" }]);
	assert.deepEqual(parseDoneWhen("## Done when\n\n`./wuxing round wood wood | grep -qx draw`\n"), [{ claim: BARE_CLAIM, cmd: "./wuxing round wood wood | grep -qx draw" }]);
	assert.deepEqual(parseDoneWhen("## Done when\n\n```sh\ntest -x ./medsched\n```\n"), [{ claim: BARE_CLAIM, cmd: "test -x ./medsched" }]);
	// The span first, then words (the acceptance series of 107).
	assert.deepEqual(parseDoneWhen("## Done when\n`./wuxing generates wood fire && ./wuxing round\n wood water` exits with status 0, and any deviation fails.\n"), [
		{ claim: BARE_CLAIM, cmd: "./wuxing generates wood fire && ./wuxing round\n wood water" },
	]);
	// Words, not a command: still no check.
	assert.deepEqual(parseDoneWhen("## Done when\n\nThe program works for every case.\n"), []);
	// Items win: the lines between them are not a command.
	assert.deepEqual(parseDoneWhen("## Done when\nbash -c true\n- x — check: `true`\n"), [{ claim: "x", cmd: "true" }]);
});

test("decide: with a plan, nothing demonstrated is not done (process ticket 107)", () => {
	const opts = { maxRounds: 3, maxMs: 0 };
	const none = decide(newState(0), { failures: [], gate: [], items: [], notes: [], planned: false, plan: true }, "t", undefined, opts);
	assert.equal(none.kind, "stop");
	if (none.kind === "stop") assert.match(none.report, /Not done .* nothing is demonstrated .* no Done when checks/);
	const unusable = [{ claim: "it is right", ok: false, unusable: true, why: "no check: the plan gives no command for this item" }];
	const all = decide(newState(0), { failures: [], gate: [], items: unusable, notes: [], planned: true, plan: true }, "t", undefined, opts);
	assert.equal(all.kind, "stop");
	if (all.kind === "stop") assert.match(all.report, /none of its 1 Done when checks could be run/);
	// No plan at all (solve, a loop with no plan step): the gate is all there is to check.
	assert.equal(decide(newState(0), { failures: [], gate: [], items: [], notes: [], planned: false, plan: false }, "t", undefined, opts).kind, "done");
});

test("decide: a search task is done only with a passing check over many inputs (process ticket 111)", () => {
	const opts = { maxRounds: 3, maxMs: 0 };
	const example = { claim: "the example", cmd: "echo '{}' | ./medsched | grep -q 07:00", ok: true, why: "" };
	const stress = { claim: "many inputs", cmd: "python3 tests/stress.py", ok: true, why: "" };
	const c = (items: (typeof example)[]): RoundCheck => ({ failures: [], gate: [], items, notes: [], planned: true, plan: true, search: true });
	const d = decide(newState(0), c([example]), "t", undefined, opts);
	assert.equal(d.kind, "stop");
	if (d.kind === "stop") assert.match(d.report, /no Done when check over many inputs passed/);
	assert.equal(decide(newState(0), c([example, stress]), "t", undefined, opts).kind, "done");
	assert.equal(decide(newState(0), { ...c([example]), search: false }, "t", undefined, opts).kind, "done");
});

test("checkRound: the committed plan's task decides whether it is a search", async () => {
	const task = "> Print a schedule.\n> If no schedule satisfies these rules, print nothing and exit with status 1.\n";
	const d = repo({ "PLAN.md": `# Plan\n\n## Task\n\n${task}\n## Done when\n- runs — check: \`true\`\n` }, "Plan");
	assert.equal((await checkRound(d, newState())).search, true);
	const w = repo({ "PLAN.md": "# Plan\n\n## Task\n\n> Print hi.\n\n## Done when\n- runs — check: `true`\n" }, "Plan");
	assert.equal((await checkRound(w, newState())).search, false);
});

test("checkRound: a committed plan with an empty Done when stops the loop as not done", async () => {
	const d = repo({ "PLAN.md": "# Plan\n\n## Steps\n1. do it\n\n## Done when\n\nIt works.\n" }, "Plan");
	commit(d, { "out.txt": "x\n" }, "work");
	const c = await checkRound(d, newState());
	assert.equal(c.plan, true);
	assert.equal(c.planned, false);
	assert.equal(decide(newState(), c, "t", undefined, { maxRounds: 3, maxMs: 0 }).kind, "stop");
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

test("runRalphHeadless: a round the model request failed stops with the error, not as no progress", async () => {
	let err: string | undefined;
	const session = {
		compact: async () => {},
		prompt: async () => {
			err = "Connection error.";
		},
		failed: () => err,
	};
	let checks = 0;
	const check = async (): Promise<RoundCheck> => {
		checks++;
		return fail(["gate: npm test failed"]);
	};
	const d = await runRalphHeadless(session, "/nowhere", "t", { maxRounds: 3, maxMs: 0 }, () => {}, check);
	assert.equal(d.kind, "stop");
	assert.match(d.kind === "stop" ? d.report : "", /model request failed \(Connection error\.\)/);
	assert.doesNotMatch(d.kind === "stop" ? d.report : "", /no progress/);
	assert.equal(checks, 1);
});

test("runRalphHeadless with the pair: the amend round goes to the planner, the rest to the worker", async () => {
	const roles: string[] = [];
	const session = { compact: async () => {}, prompt: async () => {}, role: async (r: string) => void roles.push(r) };
	const items = [{ claim: "sorted", cmd: "node s.js", ok: false, why: "exited with 1", rc: 1 }];
	const same = (): RoundCheck => ({ failures: ['Done when "sorted" — `node s.js`: exited with 1'], gate: [], items, notes: [], planned: true });
	let n = 0;
	// Like checkRound, a check consumes the amend round's permission.
	const check = async (_cwd: string, st: ReturnType<typeof newState>): Promise<RoundCheck> => {
		st.amendable = undefined;
		return n++ < 2 ? same() : fail([]);
	};
	const d = await runRalphHeadless(session, "/nowhere", "t", { maxRounds: 3, maxMs: 0 }, () => {}, check);
	assert.equal(d.kind, "done");
	assert.deepEqual(roles, ["worker", "planner", "worker"]);
});

test("ralphOptions: defaults and settings", () => {
	assert.deepEqual(ralphOptions({}), { maxRounds: 3, maxMs: 0, amendGuard: false, fresh: false });
	assert.deepEqual(ralphOptions({ NERD_RALPH_ROUNDS: "5", NERD_RALPH_MINUTES: "90" }), { maxRounds: 5, maxMs: 5_400_000, amendGuard: false, fresh: false });
	assert.deepEqual(ralphOptions({ NERD_RALPH_AMEND_GUARD: "1", NERD_RALPH_FRESH: "1" }), { maxRounds: 3, maxMs: 0, amendGuard: true, fresh: true });
});

// Ticket 083: a wrong check made the coder break right code, and the planner's
// correction then fitted the broken code (075 slug-pair-3).
test("checkRound with the amend guard: a correction that fails on the first 'done' is not taken", async () => {
	const plan = "## Done when\n- cut at the last hyphen — check: `grep -q four out.txt`\n- has a word — check: `grep -q one out.txt`\n";
	const d = repo({ "PLAN.md": plan, "out.txt": "one two\n" }, "work");
	const st = newState(0, { amendGuard: true });
	const c0 = await checkRound(d, st);
	assert.equal(c0.failures.length, 1);
	assert.ok(st.entryHead);
	// a round breaks the code to suit the wrong check
	commit(d, { "out.txt": "one two four\n" }, "fit the check");
	st.amendable = new Set(["cut at the last hyphen", "has a word"]);
	const fixed = plan.replace("grep -q four out.txt", "grep -q 'two four' out.txt").replace("grep -q one out.txt", "grep -q two out.txt");
	commit(d, { "PLAN.md": fixed }, "amend checks");
	const c = await checkRound(d, st);
	assert.equal(c.items[0].cmd, "grep -q four out.txt", "fails on the first done: the frozen command stays");
	assert.equal(c.items[1].cmd, "grep -q two out.txt", "passes on the first done too: taken");
	assert.ok(c.notes.some((n) => /corrected check was not taken .*grep -q 'two four' out.txt/.test(n)));
	// without the guard both are taken
	const st2 = newState(0);
	await checkRound(d, st2);
	st2.amendable = new Set(["cut at the last hyphen"]);
	commit(d, { "PLAN.md": fixed.replace("grep -q two out.txt", "grep -q one out.txt") }, "again");
	assert.equal((await checkRound(d, st2)).items[0].cmd, "grep -q 'two four' out.txt");
});

test("runRalphHeadless with fresh: a new session instead of compaction, and the round says so", async () => {
	const calls: string[] = [];
	const session = {
		compact: async () => void calls.push("compact"),
		fresh: async () => void calls.push("fresh"),
		prompt: async (text: string) => void calls.push(text.includes("This is a new session") ? "prompt:new" : "prompt:compacted"),
	};
	let n = 0;
	const check = async (): Promise<RoundCheck> => (n++ === 0 ? fail(["gate: npm test failed"]) : fail([]));
	await runRalphHeadless(session, "/nowhere", "t", { maxRounds: 3, maxMs: 0, fresh: true }, () => {}, check);
	assert.deepEqual(calls, ["fresh", "prompt:new"]);
	calls.length = 0;
	n = 0;
	await runRalphHeadless(session, "/nowhere", "t", { maxRounds: 3, maxMs: 0 }, () => {}, check);
	assert.deepEqual(calls, ["compact", "prompt:compacted"]);
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
			{ claim: "it says hi", cmd: "node hi.js; echo $?", ok: false, unusable: true, why: "the check cannot fail: it ends in an echo" },
		],
	});
	// an unusable check is not run: no exit code to show, and not a timeout
	assert.match(s, /✗ it says hi — `node hi.js; echo \$\?` not run: not demonstrated \(the check cannot fail/);
	assert.doesNotMatch(s, /timeout/);
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
