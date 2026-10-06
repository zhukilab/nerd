// What the harness does around the model in both modes (ticket 043): the
// questions-and-plan step at the start of a task (plan-step.ts) and the loop
// guard (loop-guard.ts). The TUI loads it from extension.ts, the headless run
// through headless.ts.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TOOLS } from "./local.ts";
import { loopGuard } from "./loop-guard.ts";
import { packageReadOnlyTools, packageTools, pinWebSearchProvider } from "./packages.ts";
import { PLAN_TOOLS, planStep, planStepOptions } from "./plan-step.ts";

/** The work's tools: ours plus those of the enabled Pi packages (packages.ts). */
export function workTools(env = process.env): string[] {
	return [...TOOLS, ...packageTools(env)];
}

/** The plan turn's tools: reading only, the packages' read-only ones included. */
export function planTools(env = process.env): string[] {
	return [...PLAN_TOOLS, ...packageReadOnlyTools(env)];
}

/** Every tool either step may switch on: what Pi must have registered (--tools). */
export function allTools(env = process.env): string[] {
	return [...new Set([...workTools(env), ...planTools(env)])];
}

/** `operator`: a person answers in this session (TUI), or not (headless). */
export function harness(operator: boolean, env = process.env): ExtensionFactory {
	return (pi) => {
		// The read-only tools are registered for the plan step only; the work
		// declares its own tools alone, as before.
		const work = workTools(env);
		pi.on("session_start", () => pi.setActiveTools(work));
		loopGuard(pi);
		if (work.includes("web_search")) pinWebSearchProvider(pi);
		const opts = planStepOptions(operator, work, env, planTools(env));
		if (opts) planStep(pi, opts);
	};
}
