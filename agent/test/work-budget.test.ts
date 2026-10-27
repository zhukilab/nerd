// The work's wall clock per turn (process ticket 089), driven through a fake Pi and a fake clock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitWork, TIME_UP_STEER, workBudget, workMaxMinutes } from "../src/work-budget.ts";
import { tempDir } from "./tmp.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function setup(maxMinutes: number, operator = false) {
	const handlers = new Map<string, Handler>();
	let active = ["read", "write", "bash"];
	let t = 0;
	let aborted = 0;
	const sent: string[] = [];
	const entries: unknown[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, h),
		getActiveTools: () => active,
		setActiveTools: (x: string[]) => {
			active = x;
		},
		appendEntry: (_type: string, data: unknown) => entries.push(data),
		sendUserMessage: (text: string) => sent.push(text),
	} as unknown as ExtensionAPI;
	const commits: string[] = [];
	const commit = (cwd: string) => {
		commits.push(cwd);
		return "abc1234";
	};
	const budget = workBudget(pi, { maxMinutes, workTools: ["read", "write", "bash"], graceMinutes: 15, now: () => t, operator, commit });
	const ctx = { abort: () => (aborted += 1), cwd: "/w" };
	const clock = (minutes: number) => {
		t = minutes * 60_000;
	};
	const at = (minutes: number) => {
		clock(minutes);
		return handlers.get("tool_result")?.({ content: [{ type: "text", text: "ok" }] }, ctx) as { content: { text: string }[] } | undefined;
	};
	const request = (minutes: number) => {
		clock(minutes);
		return handlers.get("before_provider_request")?.({ payload: { model: "m" } }) as Record<string, unknown> | undefined;
	};
	const streaming = (minutes: number) => {
		clock(minutes);
		handlers.get("message_update")?.({ message: { role: "assistant" } }, ctx);
	};
	const turn = (prompt: string) => handlers.get("before_agent_start")?.({ prompt });
	return { handlers, at, request, streaming, turn, budget, sent, entries, commits, aborted: () => aborted, tools: () => active, setTools: (x: string[]) => (active = x) };
}

test("work budget: off unless NERD_WORK_MAX_MINUTES", () => {
	assert.equal(workMaxMinutes({}), 0);
	assert.equal(workMaxMinutes({ NERD_WORK_MAX_MINUTES: "90" }), 90);
	assert.equal(workMaxMinutes({ NERD_WORK_MAX_MINUTES: "x" }), 0);
});

test("work budget: a note at the budget, the tools away and thinking off after the grace, back next turn", () => {
	const s = setup(90);
	assert.equal(s.at(0), undefined, "the clock starts at the first call of the work");
	assert.equal(s.at(89), undefined);
	assert.match(s.at(90)?.content[1].text ?? "", /time budget\. Finish now/);
	assert.equal(s.at(100), undefined, "one note");
	assert.match(s.at(105)?.content[1].text ?? "", /tools are put away/);
	assert.deepEqual(s.tools(), []);
	const p = s.handlers.get("before_provider_request")?.({ payload: { model: "m" } }) as Record<string, unknown>;
	assert.equal(p.enable_thinking, false);
	s.turn("a remark");
	assert.deepEqual(s.tools(), ["read", "write", "bash"], "the next turn gets the tools back");
	assert.equal(s.handlers.get("before_provider_request")?.({ payload: { model: "m" } }), undefined);
	assert.equal(s.at(110), undefined, "and a new clock, from its first call");
	assert.match(s.at(200)?.content[1].text ?? "", /time budget/);
});

test("work budget: the plan step's read-only calls do not start the clock", () => {
	const s = setup(10);
	s.setTools(["read", "ls"]);
	s.request(0);
	assert.equal(s.at(0), undefined);
	assert.equal(s.at(50), undefined);
	s.setTools(["read", "write"]);
	assert.equal(s.at(55), undefined, "the work starts here");
	assert.match(s.at(65)?.content[1].text ?? "", /time budget/);
});

test("work budget: the clock starts at the work's first request, not its first tool result (process ticket 092)", () => {
	const s = setup(90);
	s.request(0); // the first reply of the work thinks for 44 minutes before any call
	assert.equal(s.at(44), undefined);
	assert.match(s.at(90)?.content[1].text ?? "", /time budget/);
});

test("work budget: a reply still streaming past budget and grace is cut; the steer asks for a summary, no tools, no thinking", () => {
	const s = setup(90);
	s.request(0);
	s.streaming(104);
	assert.equal(s.aborted(), 0);
	s.streaming(105);
	assert.equal(s.aborted(), 1, "cut once");
	s.streaming(106);
	assert.equal(s.aborted(), 1);
	assert.deepEqual(s.tools(), []);
	assert.equal(s.entries.length, 1);
	const steer = s.budget.takeSteer();
	assert.ok(steer?.startsWith(TIME_UP_STEER));
	assert.match(steer ?? "", /105 minutes.*summary/s);
	assert.equal(s.budget.takeSteer(), undefined, "taken once");
	s.turn(steer as string);
	assert.deepEqual(s.tools(), [], "our own steer keeps the tools away");
	assert.equal(s.request(107)?.enable_thinking, false);
	s.turn("[harness] ralph round 1");
	assert.deepEqual(s.tools(), ["read", "write", "bash"]);
	assert.equal(s.request(108), undefined);
});

test("work budget: in the TUI the steer is sent once the cut reply has ended", () => {
	const s = setup(10, true);
	s.request(0);
	s.streaming(30);
	assert.equal(s.aborted(), 1);
	s.handlers.get("message_end")?.({});
	assert.equal(s.sent.length, 1);
	assert.ok(s.sent[0].startsWith(TIME_UP_STEER));
	assert.equal(s.budget.takeSteer(), undefined);
});

test("work budget: the plan step streaming for long is not cut (no clock yet)", () => {
	const s = setup(10);
	s.setTools(["read", "ls"]);
	s.request(0);
	s.streaming(500);
	assert.equal(s.aborted(), 0);
});

// Process ticket 090, stage 3: three of six Rust runs never committed; the gate and Ralph saw the seed.
test("work budget: when the time is up the harness commits the working tree, and says so", () => {
	const cut = setup(90);
	cut.request(0);
	cut.streaming(105);
	assert.deepEqual(cut.commits, ["/w"], "committed at the cut, in the session's cwd");
	assert.match(cut.budget.takeSteer() ?? "", /committed your working tree as abc1234/);
	const away = setup(90);
	away.at(0);
	away.at(90);
	assert.match(away.at(105)?.content[1].text ?? "", /tools are put away\. The harness committed your working tree as abc1234/);
	assert.equal(away.commits.length, 1);
});

test("work budget: a guard's steer after its cut does not restart the clock", () => {
	const s = setup(90);
	s.request(0);
	s.turn("[harness] Your reply was cut: you were computing by hand (\"2 * 3 = 6\").");
	assert.match(s.at(90)?.content[1].text ?? "", /time budget/, "the clock of the turn goes on");
});

test("commitWork: commits what changed (untracked too, not target/ or node_modules), nothing when clean", () => {
	const d = tempDir("nerd-commit-work-");
	const git = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(d, "a.rs"), "1\n");
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
	assert.equal(commitWork(d, 105), undefined, "nothing to commit");
	writeFileSync(join(d, "a.rs"), "2\n");
	writeFileSync(join(d, "b.rs"), "new\n");
	mkdirSync(join(d, "target"));
	writeFileSync(join(d, "target", "x"), "built\n");
	const sha = commitWork(d, 105);
	assert.match(sha ?? "", /^[0-9a-f]{7,}$/);
	assert.match(git("log", "-1", "--format=%s").stdout, /Work in progress at the work's time budget \(105 min\), committed by the harness/);
	assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n").sort(), ["a.rs", "b.rs"]);
	assert.equal(git("status", "--porcelain").stdout.trim(), "?? target/");
	assert.equal(commitWork(tempDir("nerd-commit-nogit-"), 1), undefined, "not a repository");
});
