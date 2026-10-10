// The plan step with plan-lint (ticket 065 of the process), driven through a
// fake Pi: a plan with an unusable check goes back once; the corrected plan is
// saved; a plan still wrong after the retry is saved with a "Plan lint" section.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_TOOLS, planStep, planStepOptions } from "../src/plan-step.ts";
import { tempDir } from "./tmp.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, h),
		registerCommand: () => {},
		setActiveTools: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function session(cwd: string, env: Record<string, string>) {
	const { pi, handlers } = fakePi();
	const opts = planStepOptions(false, ["read", "write", "bash"], env, PLAN_TOOLS);
	assert.ok(opts);
	planStep(pi, opts);
	const ctx = { cwd, sessionManager: { getBranch: () => [] } };
	handlers.get("before_agent_start")?.({ prompt: "build a semver module" }, ctx);
	const reply = (text: string, stopReason = "stop") =>
		handlers.get("agent_before_settle")?.(
			{ outcome: "completed", context: { contextMessages: [{ role: "assistant", content: text, stopReason }] } },
			ctx,
		) as { entries: { customType: string; content: string }[]; continue: boolean };
	return Object.assign(reply, { request: (payload: object) => handlers.get("before_provider_request")?.({ payload }, ctx) });
}

const BAD = "ASSUMPTIONS\n- none\nQUESTIONS\nnone\nPLAN\n1. write semver.js — check: `npm test`\nDONE WHEN\n- parses — check: `node -e \"import('./semver.js').then(m=>console.log(m.parse('1.2.3')))\"` prints the version\n";
const GOOD = "PLAN\n1. write semver.js — check: `npm test`\nDONE WHEN\n- parses — check: `node -e \"import('./semver.js').then(m=>process.exit(m.parse('1.2.3').major===1?0:1))\"`\n";

function repo(): string {
	const d = tempDir("nerd-plan-lint-test-");
	spawnSync("git", ["init", "-q"], { cwd: d });
	spawnSync("git", ["config", "user.name", "t"], { cwd: d });
	spawnSync("git", ["config", "user.email", "t@t"], { cwd: d });
	return d;
}

test("plan-lint: an unusable check goes back once; the corrected plan is saved", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	const first = reply(BAD);
	assert.equal(first.entries[0].customType, "nerd-plan-lint");
	assert.match(first.entries[0].content, /only prints/);
	const second = reply(GOOD);
	assert.equal(second.entries[0].customType, "nerd-plan");
	const saved = readFileSync(join(d, "PLAN.md"), "utf8");
	assert.match(saved, /process\.exit/);
	assert.doesNotMatch(saved, /## Plan lint/);
});

test("plan-lint: still wrong after the retry — saved with the findings, the work goes on", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	reply(BAD);
	const second = reply(BAD);
	assert.equal(second.entries[0].customType, "nerd-plan");
	assert.match(readFileSync(join(d, "PLAN.md"), "utf8"), /## Plan lint[\s\S]*only prints/);
});

// Ticket 070: after the call budget the tools are put away and the model went on
// "calling" them as text (4 of 20 plans of the plan-only stand).
const CALL = "<tool_call>\n<function=read>\n<parameter=path>\ntest/slug.test.js\n</parameter>\n</function>\n</tool_call>";

test("tool-call text: a reply that is only a call gets a direct note, at most twice", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	const first = reply(CALL);
	assert.equal(first.entries[0].customType, "nerd-plan");
	assert.match(first.entries[0].content, /not run/);
	assert.match(first.entries[0].content, /read/);
	assert.match(reply(CALL).entries[0].content, /not run/);
	const third = reply(CALL);
	assert.match(third.entries[0].content, /plan-lint|saved/); // no third note: lint, then save
});

test("tool-call text: a plan with a call after it is saved without the call", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	const r = reply(`Now the plan.\n\n${GOOD}\n${CALL}\n`);
	assert.equal(r.entries[0].customType, "nerd-plan");
	const saved = readFileSync(join(d, "PLAN.md"), "utf8");
	assert.match(saved, /process\.exit/);
	assert.doesNotMatch(saved, /tool_call|function=/);
});

// Ticket 071: a plan step whose one reply kept re-drafting the plan for 40 minutes.
test("plan step: max_tokens is capped while planning, not during the work", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	assert.deepEqual(reply.request({ max_tokens: 16384, model: "m" }), { max_tokens: 6144, model: "m" });
	assert.deepEqual(reply.request({ max_tokens: 1000 }), { max_tokens: 1000 });
	reply(GOOD);
	assert.equal(reply.request({ max_tokens: 16384 }), undefined);
	const capped = session(repo(), { NERD_PLAN_MAX_TOKENS: "0" });
	assert.equal(capped.request({ max_tokens: 16384 }), undefined);
});

test("plan step: a reply cut at the cap gives its last complete draft", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	const draft1 = GOOD.replace("write semver.js", "first draft");
	const draft2 = GOOD.replace("write semver.js", "second draft");
	const r = reply(`${draft1}\nHmm, actually, wait. Let me redo it.\n\n${draft2}\nActually no.\n\nPLAN\n1. third dra`, "length");
	assert.equal(r.entries[0].customType, "nerd-plan");
	const saved = readFileSync(join(d, "PLAN.md"), "utf8");
	assert.match(saved, /second draft/);
	assert.doesNotMatch(saved, /first draft|third dra|Hmm/);
});

test("plan step: a reply with two drafts, not cut, gives its last one (with the assumptions)", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1" });
	const draft1 = "PLAN\n1. first draft — check: `npm test`\nDONE WHEN\n- it works\n";
	reply(`ASSUMPTIONS\n- ESM\nQUESTIONS\nnone\n${draft1}\nNow with commands:\n\n${GOOD}`);
	const saved = readFileSync(join(d, "PLAN.md"), "utf8");
	assert.match(saved, /process\.exit/);
	assert.doesNotMatch(saved, /first draft/);
	assert.match(saved, /## Assumptions[\s\S]*ESM/);
	assert.equal((saved.match(/## Done when/g) ?? []).length, 1);
});

test("plan step: a reply cut at the cap with no complete draft gets a note, at most twice", () => {
	const reply = session(repo(), { NERD_RALPH: "1" });
	const cut = "PLAN\n1. read the tests — check: `npm test`\nHmm, wait, let me reconsider";
	assert.match(reply(cut, "length").entries[0].content, /re-?draft|final plan/i);
	assert.match(reply(cut, "length").entries[0].content, /re-?draft|final plan/i);
	assert.doesNotMatch(reply(cut, "length").entries[0].content, /length budget/);
});

test("plan-lint: NERD_PLAN_LINT=0 saves the plan as it is", () => {
	const d = repo();
	const reply = session(d, { NERD_RALPH: "1", NERD_PLAN_LINT: "0" });
	assert.equal(reply(BAD).entries[0].customType, "nerd-plan");
	assert.doesNotMatch(readFileSync(join(d, "PLAN.md"), "utf8"), /## Plan lint/);
});
