// The TUI's modes (mode.ts, process ticket 104): the pure parts, and a letter of an
// agora channel against the modes and the plan step wired as in harness.ts. The
// sessions with the modes are in harness.test.ts ("modes: …").

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitAll, commitPlan, headlessMode, modes, newModeState, planCommit, type PlanStepHandle, solveSubject, TALK_NOTE } from "../src/mode.ts";
import { ralph, ralphOptions } from "../src/ralph.ts";
import { letterPrompt, PLAN_TOOLS, planFileText, planStep, planStepOptions, planStepPrompt, planTask, revisedTask, savePlan } from "../src/plan-step.ts";
import { tempDir } from "./tmp.ts";

for (const [k, v] of Object.entries({
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
})) process.env[k] = v;

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd }).toString().trim();

test("mode of a new session: talk with an operator, ralph without one", () => {
	assert.equal(newModeState(true, {}).mode, "talk");
	assert.equal(newModeState(false, {}).mode, "ralph");
});

test("solveSubject: the first non-empty line, a heading skipped, cut at 60", () => {
	assert.equal(solveSubject("\n  fix the colour \nand more"), "Solve: fix the colour");
	assert.equal(solveSubject("# Problem\n\nA clock in red."), "Solve: A clock in red.");
	assert.equal(solveSubject("# Problem"), "Solve: # Problem");
	assert.equal(solveSubject("x".repeat(80)), `Solve: ${"x".repeat(57)}...`);
});

test("commitAll: a repository made if none, node_modules and target left out at any depth; nothing to commit is no commit", () => {
	const d = tempDir("nerd-mode-");
	writeFileSync(join(d, "a.txt"), "a\n");
	for (const dir of ["node_modules", "target", "web/node_modules"]) mkdirSync(join(d, dir), { recursive: true });
	writeFileSync(join(d, "node_modules", "x.js"), "x\n");
	writeFileSync(join(d, "target", "y"), "y\n");
	writeFileSync(join(d, "web", "node_modules", "z.js"), "z\n");
	writeFileSync(join(d, "web", "page.html"), "<p>\n");
	assert.deepEqual(commitAll(d, "Before solve"), { committed: "Before solve" });
	assert.deepEqual(git(d, "show", "--name-only", "--format=", "HEAD").split("\n"), ["a.txt", "web/page.html"]);
	assert.deepEqual(commitAll(d, "Solve: again"), {});
	assert.equal(git(d, "log", "--format=%s"), "Before solve");
});

test("commitAll in a subdirectory of a repository: no repository inside it; only that subdirectory is committed", () => {
	const d = tempDir("nerd-mode-");
	git(d, "init", "-q");
	mkdirSync(join(d, "app"));
	writeFileSync(join(d, "outside.txt"), "o\n");
	git(d, "add", "outside.txt");
	writeFileSync(join(d, "app", "b.txt"), "b\n");
	assert.deepEqual(commitAll(join(d, "app"), "Before solve"), { committed: "Before solve" });
	assert.ok(!existsSync(join(d, "app", ".git")));
	assert.equal(git(d, "show", "--name-only", "--format=", "HEAD"), "app/b.txt");
	assert.equal(git(d, "status", "--porcelain"), "A  outside.txt", "what was staged outside stays staged");
});

test("commitAll: git's refusal comes back as an error, not as silence", () => {
	const d = tempDir("nerd-mode-");
	writeFileSync(join(d, "a.txt"), "a\n");
	const env = { ...process.env };
	process.env.GIT_AUTHOR_NAME = "";
	process.env.GIT_COMMITTER_NAME = "";
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	try {
		const r = commitAll(d, "Before solve");
		assert.equal(r.committed, undefined);
		assert.ok(r.error);
	} finally {
		Object.assign(process.env, env);
	}
});

test("commitPlan: an uncommitted PLAN.md becomes the 'Plan' commit; one committed under another name is reported", async () => {
	const d = tempDir("nerd-mode-");
	writeFileSync(join(d, "PLAN.md"), "# Plan\n\n1. a\n");
	assert.equal(await commitPlan(d), undefined);
	assert.equal(git(d, "log", "--format=%s"), "Plan");
	assert.equal(await commitPlan(d), undefined, "the same plan again: nothing to say");
	writeFileSync(join(d, "PLAN.md"), "# Plan\n\n1. b\n");
	git(d, "commit", "-qam", "my edit of the plan");
	assert.match((await commitPlan(d)) ?? "", /not as "Plan"/);
});

/** The modes and the plan step on a fake Pi that keeps every handler, in order, as harness.ts registers them. */
function wired() {
	const handlers: [string, (event: unknown, ctx: unknown) => unknown][] = [];
	let tools: string[] = [];
	const pi = {
		on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.push([name, h]),
		registerCommand: () => {},
		setActiveTools: (t: string[]) => {
			tools = t;
		},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const state = newModeState(true);
	const step: PlanStepHandle = {};
	const work = ["read", "write", "bash"];
	modes(pi, state, { planTools: PLAN_TOOLS, workTools: work, step });
	ralph(pi, ralphOptions({}), undefined, state);
	const opts = planStepOptions(true, work, {}, PLAN_TOOLS);
	assert.ok(opts);
	Object.assign(step, planStep(pi, { ...opts, mode: state }));
	const ctx = { cwd: tempDir("nerd-mode-letter-"), sessionManager: { getBranch: () => [] }, ui: { notify: () => {} } };
	type Out = { message?: { content?: string } } | undefined;
	// In registration order, each awaited, as Pi runs them: modes, the Ralph loop, the plan step.
	const start = async (prompt: string) => {
		const out: Out[] = [];
		for (const [n, h] of handlers) if (n === "before_agent_start") out.push((await h({ prompt }, ctx)) as Out);
		return { byModes: out[0], byStep: out.at(-1) };
	};
	return { state, start, tools: () => tools };
}

test("in talk, a letter with a task: subject is /task — no talk note, the plan step, then ralph; Ralph takes the task once", async () => {
	const w = wired();
	letterPrompt("Letter: task: add a README", true);
	const { byModes, byStep } = await w.start("Letter: task: add a README");
	assert.equal(byModes, undefined, "no talk note on a task");
	assert.match(byStep?.message?.content ?? "", /A new task/);
	assert.deepEqual(w.tools(), PLAN_TOOLS);
	assert.equal(w.state.mode, "ralph");
	assert.equal(w.state.fresh, false, "the Ralph loop took the letter as its task; the answer that follows is no new task");
});

test("in talk, a letter that is no task is conversation: the talk note, reading tools", async () => {
	const w = wired();
	letterPrompt("Letter: how is it going?", false);
	const { byModes, byStep } = await w.start("Letter: how is it going?");
	assert.equal(byModes?.message?.content, TALK_NOTE);
	assert.equal(byStep, undefined);
	assert.deepEqual(w.tools(), PLAN_TOOLS);
	assert.equal(w.state.mode, "talk");
});

test("a mode command while the agent works is refused: the mode stays, nothing is sent", async () => {
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const sent: string[] = [];
	const pi = {
		on: () => {},
		registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c.handler),
		setActiveTools: () => {},
		sendUserMessage: (t: string) => sent.push(t),
	} as unknown as ExtensionAPI;
	const state = newModeState(true);
	modes(pi, state, { planTools: PLAN_TOOLS, workTools: ["write"], step: { markTask: () => {}, cancel: () => {} } });
	const notes: string[] = [];
	const ctx = { cwd: tempDir("nerd-mode-busy-"), isIdle: () => false, ui: { notify: (m: string) => notes.push(m) } };
	for (const name of ["solve", "plan", "talk"]) await commands.get(name)?.("go", ctx);
	assert.equal(state.mode, "talk");
	assert.deepEqual(sent, []);
	assert.equal(notes.length, 3);
	assert.match(notes[0], /the agent is working/);
});

test("headless modes: NERD_MODE plan | solve | ralph, unset is ralph, anything else refused", () => {
	assert.equal(headlessMode({}), "ralph");
	assert.equal(headlessMode({ NERD_MODE: " plan " }), "plan");
	assert.equal(headlessMode({ NERD_MODE: "solve" }), "solve");
	assert.throws(() => headlessMode({ NERD_MODE: "talk" }), /one of plan, solve, ralph/);
	assert.deepEqual(newModeState(true, { NERD_MODE: "plan" }), { mode: "talk" }, "the TUI starts in talk whatever NERD_MODE says");
	assert.deepEqual(newModeState(false, { NERD_MODE: "solve" }), { mode: "solve" });
});

test("revision: the task PLAN.md quotes, a TUI change added to it, a headless task in its place", () => {
	const plan = planFileText("Make a clock.\n\nIn red.", { assumptions: "", plan: "PLAN\n1. x\nDONE WHEN\n- y" });
	assert.equal(planTask(plan), "Make a clock.\n\nIn red.");
	assert.equal(planTask("# Plan\n\n## Steps\n1. x\n"), "");
	assert.equal(revisedTask("Make a clock.", "  in blue ", true), "Make a clock.\n\nChange: in blue");
	assert.equal(revisedTask("Make a clock.", "Make a timer.", false), "Make a timer.");
	assert.equal(revisedTask("", "in blue", true), "in blue");
	assert.match(planStepPrompt(true, false, "", "# Plan\n1. x"), /^\[harness\] A revision of the plan[\s\S]*# Plan\n1\. x[\s\S]*Reply in exactly this form/);
});

test("planCommit: the last commit named Plan, none without one or without a repository", () => {
	const d = tempDir("nerd-mode-plan-");
	assert.equal(planCommit(d), undefined);
	writeFileSync(join(d, "PLAN.md"), "a\n");
	commitAll(d, "Not a plan");
	assert.equal(planCommit(d), undefined);
	savePlan(d, "b\n");
	const sha = planCommit(d);
	assert.match(sha ?? "", /^[0-9a-f]{40}$/);
	commitAll(d, "Later");
	assert.equal(planCommit(d), sha);
});
