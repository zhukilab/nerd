// The round gate, the pause and the resume of a long run (#978 of the agora board, nerd).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, newState, type RalphState, type RoundCheck, ralphOptions, runRalphHeadless } from "../src/ralph.ts";
import { askGate, fromSaved, type GateInfo, gateEnv, loadRun, parseGate, resumeMessage, saveRun, statePath, toSaved } from "../src/ralph-gate.ts";
import { tempDir } from "./tmp.ts";

const info = (cwd: string, over: Partial<GateInfo> = {}): GateInfo => ({
	round: 2,
	activeMs: 90 * 60_000,
	roundsMs: [60 * 60_000, 30 * 60_000],
	budgetMs: 0,
	failing: 3,
	cwd,
	graceMinutes: 15,
	...over,
});

test("parseGate: continue by default, pause, a turn's minutes, a reason", () => {
	assert.deepEqual(parseGate(0, ""), { decision: "continue", reason: undefined });
	assert.deepEqual(parseGate(0, "some talk\ndecision=continue\n"), { decision: "continue", reason: undefined });
	assert.deepEqual(parseGate(0, "decision=continue\nwork_minutes=40\nreason=until 07:00"), { decision: "continue", workMinutes: 40, reason: "until 07:00" });
	assert.deepEqual(parseGate(0, "decision=pause\nreason=the night is over"), { decision: "pause", reason: "the night is over" });
	assert.deepEqual(parseGate(0, "decision=pause"), { decision: "pause", reason: "the gate said pause" });
});

test("parseGate: a failing gate is a pause, said as a failure", () => {
	for (const [status, out, err] of [
		[1, "decision=continue", undefined],
		[null, "", undefined],
		[0, "", "spawn sh ENOENT"],
		[0, "decision=maybe", undefined],
		[0, "decision=continue\nwork_minutes=0", undefined],
		[0, "work_minutes=soon", undefined],
	] as [number | null, string, string | undefined][]) {
		const a = parseGate(status, out, err);
		assert.equal(a.decision, "pause", `${status} ${out} ${err}`);
		if (a.decision === "pause") {
			assert.equal(a.failed, true);
			assert.match(a.reason, /^the gate failed: /);
		}
	}
});

test("askGate: runs the command with the round's numbers in its environment", () => {
	const d = tempDir("nerd-gate-");
	const script = join(d, "gate.sh");
	writeFileSync(
		script,
		'echo "decision=continue"\necho "work_minutes=$NERD_GATE_ROUND$NERD_GATE_FAILING"\necho "reason=$NERD_GATE_ACTIVE_MINUTES $NERD_GATE_LAST_ROUND_MINUTES $NERD_GATE_MEAN_ROUND_MINUTES $NERD_GATE_LONGEST_ROUND_MINUTES $NERD_GATE_GRACE_MINUTES $(pwd)"\n',
	);
	const a = askGate(`sh ${script}`, info(d));
	assert.deepEqual(a, { decision: "continue", workMinutes: 23, reason: `90.0 30.0 45.0 60.0 15 ${d}` });
	assert.equal(gateEnv(info(d, { roundsMs: [] })).NERD_GATE_LAST_ROUND_MINUTES, "");
});

test("askGate: an error exit and a gate that does not answer in time are pauses", () => {
	const d = tempDir("nerd-gate-");
	const failed = askGate("echo oops >&2; exit 3", info(d));
	assert.equal(failed.decision, "pause");
	if (failed.decision === "pause") assert.match(failed.reason, /exit 3 — oops/);
	const slow = askGate("sleep 5", info(d), process.env, 200);
	assert.equal(slow.decision, "pause");
	if (slow.decision === "pause") assert.match(slow.reason, /the gate failed: no answer in 0 s|killed/);
});

const fail = (f: string[], tree?: string): RoundCheck => ({ failures: f, items: [], notes: [], planned: true, tree });

test("decide, progress work: the same failures go on while the tree changes; two rounds with neither changed pause", () => {
	const o = { ...ralphOptions({ NERD_RALPH_PROGRESS: "work", NERD_RALPH_ROUNDS: "100" }) };
	assert.equal(o.progress, "work");
	const st = newState(0);
	assert.equal(decide(st, fail(["a", "b"], "t1"), "t", undefined, o, 1).kind, "next");
	assert.equal(decide(st, fail(["b", "a"], "t2"), "t", undefined, o, 2).kind, "next", "the code moved on");
	assert.equal(decide(st, fail(["a", "b"], "t3"), "t", undefined, o, 3).kind, "next");
	assert.equal(decide(st, fail(["a", "b"], "t3"), "t", undefined, o, 4).kind, "next", "one round without a change is not yet a stall");
	const before = st.round;
	const d = decide(st, fail(["a", "b"], "t3"), "t", undefined, o, 5);
	assert.equal(d.kind, "pause", "a stall of a long run is a pause for the operator, not the end");
	if (d.kind === "pause") {
		assert.equal(d.stalled, true);
		assert.match(d.report, /two rounds in a row changed neither the failing checks nor the committed code \(a stall/);
		assert.match(d.message ?? "", new RegExp(`\\[ralph round ${before + 1}/100\\]`), "the round to send on a resume");
	}
	assert.equal(st.stalls, 0, "a resume starts counting again");
	const st2 = newState(0);
	decide(st2, fail(["a"], "t1"), "t", undefined, o, 1);
	decide(st2, fail(["a"], "t1"), "t", undefined, o, 2);
	assert.equal(decide(st2, fail(["b"], "t1"), "t", undefined, o, 3).kind, "next", "other failures are a change");
	assert.equal(st2.stalls, 0);
});

test("decide, progress work: no amend round while the code moves on; only when it stalls", () => {
	const o = { maxRounds: 100, maxMs: 0, progress: "work" as const };
	const items = [{ claim: "sorted", cmd: "node s.js", ok: false, why: "exited with 1", rc: 1 }];
	const c = (tree: string): RoundCheck => ({ failures: ['Done when "sorted" — `node s.js`: exited with 1'], gate: [], items, notes: [], planned: true, tree });
	const st = newState(0);
	decide(st, c("t1"), "t", undefined, o, 1);
	const moved = decide(st, c("t2"), "t", undefined, o, 2);
	assert.equal(moved.kind, "next");
	assert.equal(st.amendUsed, undefined, "same red checks, new code: a plain round");
	const still = decide(st, c("t2"), "t", undefined, o, 3);
	assert.equal(still.kind, "next");
	assert.equal(st.amendUsed, true, "same red checks and the same code: the checks may be wrong");
	if (still.kind === "next") assert.match(still.message, /A check can be wrong about the code/);
});

test("decide, progress work: one correction per check, not per task", () => {
	const o = { maxRounds: 100, maxMs: 0, progress: "work" as const };
	const st = newState(0, o);
	assert.equal(st.perClaim, true);
	const item = (claim: string) => ({ claim, cmd: `node ${claim}.js`, ok: false, why: "exited with 1", rc: 1 });
	const c = (claims: string[], tree: string): RoundCheck => ({
		failures: claims.map((x) => `Done when "${x}" — \`node ${x}.js\`: exited with 1`),
		gate: [],
		items: claims.map(item),
		notes: [],
		planned: true,
		tree,
	});
	decide(st, c(["a"], "t1"), "t", undefined, o, 1);
	const first = decide(st, c(["a"], "t1"), "t", undefined, o, 2);
	assert.equal(first.kind, "next");
	assert.deepEqual([...(st.amendable ?? [])], ["a"]);
	if (first.kind === "next") assert.match(first.message, /Only these checks may be corrected now, each once in the task: "a"/);
	st.amendable = undefined; // checkRound takes (or drops) the correction
	decide(st, c(["b"], "t2"), "t", undefined, o, 3);
	const second = decide(st, c(["b"], "t2"), "t", undefined, o, 4);
	assert.equal(second.kind, "next");
	assert.deepEqual([...(st.amendable ?? [])], ["b"], "another check gets its own correction");
	st.amendable = undefined;
	decide(st, c(["a"], "t3"), "t", undefined, o, 5);
	const again = decide(st, c(["a"], "t3"), "t", undefined, o, 6);
	const offered = st.amendable as Set<string> | undefined;
	assert.ok(again.kind !== "next" || !offered?.has("a"), "a check corrected once is not offered again");
	const ds = newState(0);
	assert.equal(ds.perClaim, undefined, "the default stays one per task");
});

test("runRalphHeadless, progress work: a stall is saved as a pause with its round, marked stalled", async () => {
	const session = { compact: async () => {}, prompt: async () => {} };
	const paused: { reason: string; next: string; stalled?: boolean }[] = [];
	const o = { maxRounds: 100, maxMs: 0, progress: "work" as const };
	const d = await runRalphHeadless(session, "/nowhere", "t", o, () => {}, async () => fail(["x"], "same-tree"), { state: newState(0, o), onPause: (p) => paused.push(p) });
	assert.equal(d.kind, "pause");
	assert.equal(paused.length, 1);
	assert.equal(paused[0].stalled, true);
	assert.match(paused[0].reason, /^Paused after round \d+: two rounds in a row/);
	assert.match(paused[0].next, /\[ralph round \d+\/100\]/);
});

test("decide, default progress: the same failures twice still stop at once", () => {
	const st = newState(0);
	decide(st, fail(["a"], "t1"), "t", undefined, { maxRounds: 9, maxMs: 0 }, 1);
	assert.equal(decide(st, fail(["a"], "t2"), "t", undefined, { maxRounds: 9, maxMs: 0 }, 2).kind, "stop");
});

test("runRalphHeadless with a gate: a pause before the round hands over the round's message, nothing is prompted", async () => {
	const prompts: string[] = [];
	const session = { compact: async () => {}, prompt: async (t: string) => void prompts.push(t) };
	let clock = 1000;
	const st = newState(0);
	const seen: GateInfo[] = [];
	const paused: { reason: string; next: string; role: string }[] = [];
	const d = await runRalphHeadless(session, "/nowhere", "the task", { maxRounds: 5, maxMs: 0 }, () => {}, async () => fail(["gate: npm test failed"]), {
		state: st,
		turnStarted: 0,
		now: () => clock,
		gate: (i) => {
			seen.push({ ...i, roundsMs: [...i.roundsMs] });
			return { decision: "pause", reason: "07:00, the night is over" };
		},
		onPause: (p) => paused.push(p),
	});
	assert.equal(d.kind, "pause");
	if (d.kind === "pause") assert.match(d.report, /Paused by the gate before round 1: 07:00, the night is over/);
	assert.deepEqual(prompts, []);
	assert.equal(paused.length, 1);
	assert.match(paused[0].next, /\[ralph round 1\/5\]/);
	assert.equal(paused[0].role, "worker");
	assert.equal(seen[0].round, 1);
	assert.deepEqual(seen[0].roundsMs, [1000], "the first delivery's time");
	assert.equal(seen[0].failing, 1);
	clock = 0;
});

test("runRalphHeadless with a gate: continue sets the next turn's minutes, then done", async () => {
	const prompts: string[] = [];
	const session = { compact: async () => {}, prompt: async (t: string) => void prompts.push(t) };
	let n = 0;
	const minutes: (number | undefined)[] = [];
	const d = await runRalphHeadless(session, "/nowhere", "t", { maxRounds: 5, maxMs: 0 }, () => {}, async () => (n++ === 0 ? fail(["x"]) : fail([])), {
		gate: () => ({ decision: "continue", workMinutes: 25 }),
		setWorkMinutes: (m) => minutes.push(m),
	});
	assert.equal(d.kind, "done");
	assert.equal(prompts.length, 1);
	assert.deepEqual(minutes, [25]);
});

test("saved run: state round-trips; the clock counts the active time; an ended run is not resumed", () => {
	const d = tempDir("nerd-gate-state-");
	const st: RalphState = {
		...newState(1_000),
		round: 4,
		lastKey: "a\nb",
		lastTree: "t9",
		stalls: 1,
		amendUsed: true,
		entryHead: "abc",
		roundsMs: [5, 6],
	};
	st.failedHash.set("npm test", "h1");
	st.amended.set("sorted", { from: "node a.js", to: "node b.js" });
	st.amendable = new Set(["sorted"]);
	const path = join(d, "sub", "state.json");
	saveRun(path, toSaved(st, { task: "build it", reason: "07:00", status: "paused", activeMs: 3_600_000, roundsMs: [2_400_000, 3_000_000], next: "[ralph round 4/9] go", role: "planner", now: new Date("2026-11-20T06:00:00Z") }));
	const s = loadRun(path);
	assert.ok(!("error" in s));
	if ("error" in s) return;
	const back = fromSaved(s, 10_000_000);
	assert.equal(back.started, 10_000_000 - 3_600_000);
	assert.equal(back.round, 4);
	assert.equal(back.lastKey, "a\nb");
	assert.equal(back.lastTree, "t9");
	assert.equal(back.stalls, 1);
	assert.equal(back.failedHash.get("npm test"), "h1");
	assert.deepEqual(back.amended.get("sorted"), { from: "node a.js", to: "node b.js" });
	assert.deepEqual([...(back.amendable ?? [])], ["sorted"]);
	assert.deepEqual(back.roundsMs, [2_400_000, 3_000_000]);
	const m = resumeMessage(s);
	assert.match(m, /^\[ralph: resumed\] The run was paused at 2026-11-20T06:00:00.000Z \(07:00\) after 90.0 min of active work/, "the turns' sum, not the loop's clock");
	assert.match(m, /\[ralph round 4\/9\] go$/);
	assert.match(resumeMessage({ ...s, next: undefined }), /Carry on with the task: build it$/);
	saveRun(path, { ...s, status: "ended", reason: "done" });
	const ended = loadRun(path);
	assert.ok("error" in ended && /has ended \(done\)/.test(ended.error));
	const none = loadRun(join(d, "none.json"));
	assert.ok("error" in none && /nothing to resume/.test(none.error));
});

test("statePath: inside the workspace's .git by default; NERD_RALPH_STATE relative to the workspace or absolute", () => {
	const d = tempDir("nerd-gate-path-");
	spawnSync("git", ["init", "-q"], { cwd: d });
	assert.equal(statePath(d, {}), join(d, ".git", "nerd-ralph-state.json"));
	assert.equal(statePath(d, { NERD_RALPH_STATE: "var/s.json" }), join(d, "var", "s.json"));
	assert.equal(statePath(d, { NERD_RALPH_STATE: "/x/s.json" }), "/x/s.json");
	const bare = tempDir("nerd-gate-nogit-");
	assert.equal(statePath(bare, {}), join(bare, ".nerd-ralph-state.json"));
});
