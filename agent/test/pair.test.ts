// The ping-pong pair (pair.ts, ticket 075 of the process): the switch between the
// planner and the worker on a scripted Pi, and the plan step handing the plan to
// the planner and the work back to the worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLANNER, pairOn, pairSwitch } from "../src/pair.ts";
import { planStep, planStepOptions } from "../src/plan-step.ts";
import { tempDir } from "./tmp.ts";

type M = { provider: string; id: string };
const WORKER: M = { provider: "local", id: "bonsai" };
const PLAN_MODEL: M = { provider: PLANNER, id: "qwen" };

function fakePi(start: M, registered: M[]) {
	const state = { model: start, set: [] as string[] };
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const pi = {
		setModel: async (m: M) => {
			state.model = m;
			state.set.push(m.id);
			return true;
		},
		on: (name: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(name, h),
		setActiveTools: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
	};
	const ctx = (cwd = "/nowhere") => ({
		get model() {
			return state.model;
		},
		modelRegistry: { getAll: () => registered },
		cwd,
		sessionManager: { getBranch: () => [] },
	});
	return { pi, state, handlers, ctx };
}

test("pairOn: only with NERD_PLAN_BASE_URL", () => {
	assert.equal(pairOn({}), false);
	assert.equal(pairOn({ NERD_PLAN_BASE_URL: "http://planner:8080/v1" }), true);
	assert.equal(planStepOptions(false, [], { NERD_PLAN_BASE_URL: "http://p/v1" })?.pair, true);
	assert.equal(planStepOptions(false, [], {})?.pair, false);
});

test("pairSwitch: to the planner and back to the worker it came from; idempotent; nothing without a planner", async () => {
	const f = fakePi(WORKER, [WORKER, PLAN_MODEL]);
	// biome-ignore lint/suspicious/noExplicitAny: a scripted Pi
	const role = pairSwitch(f.pi as any);
	// biome-ignore lint/suspicious/noExplicitAny: a scripted context
	const c = f.ctx() as any;
	await role("worker", c);
	await role("planner", c);
	await role("planner", c);
	assert.equal(f.state.model.id, "qwen");
	await role("worker", c);
	await role("worker", c);
	assert.deepEqual(f.state.set, ["qwen", "bonsai"]);

	const lone = fakePi(WORKER, [WORKER]);
	// biome-ignore lint/suspicious/noExplicitAny: a scripted Pi
	const r2 = pairSwitch(lone.pi as any);
	// biome-ignore lint/suspicious/noExplicitAny: a scripted context
	await r2("planner", lone.ctx() as any);
	assert.deepEqual(lone.state.set, []);
});

test("the plan step with the pair: the planner writes the plan, the worker takes the work", async () => {
	const f = fakePi(WORKER, [WORKER, PLAN_MODEL]);
	const opts = planStepOptions(false, ["read", "write"], { NERD_PLAN_BASE_URL: "http://p/v1", NERD_PLAN_LINT: "0" });
	assert.ok(opts);
	// biome-ignore lint/suspicious/noExplicitAny: a scripted Pi
	planStep(f.pi as any, opts);
	const cwd = tempDir("nerd-pair-test-");
	await f.handlers.get("before_agent_start")?.({ prompt: "build it" }, f.ctx(cwd));
	assert.equal(f.state.model.id, "qwen", "the plan turn runs on the planner");
	const reply = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "## PLAN\n1. do it\n\n## DONE WHEN\n- it works" }] };
	const r = (await f.handlers.get("agent_before_settle")?.({ outcome: "completed", context: { contextMessages: [reply] } }, f.ctx(cwd))) as {
		continue?: boolean;
	};
	assert.equal(r?.continue, true, "the work prompt follows");
	assert.equal(f.state.model.id, "bonsai", "the work runs on the worker");
	assert.deepEqual(f.state.set, ["qwen", "bonsai"]);
});
