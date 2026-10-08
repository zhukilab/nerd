// What the harness does around the model in both modes (ticket 043): the
// questions-and-plan step at the start of a task (plan-step.ts), the loop
// guard (loop-guard.ts), the fetch guard (fetch-guard.ts), the linters
// after every edit (lint-check.ts), long bash output cut to head and tail
// (output-cap.ts), web pages kept in notes/web/ (web-notes.ts), the anchors
// after a compaction (anchors.ts, ticket 057 of the process), the done gate
// (done-gate.ts), the sampling settings of every request (sampling.ts,
// NERD_SAMPLING), the operator's rules for every project (rules.ts) and the
// compaction summary's goal set to the task (summary-goal.ts; process ticket
// 061). The TUI loads it from
// extension.ts, the headless run through headless.ts.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { anchors, anchorsOn } from "./anchors.ts";
import { doneGate, doneGateOn, doneGateRounds } from "./done-gate.ts";
import { fetchGuard, fetchGuardOn } from "./fetch-guard.ts";
import { lintCheck, lintOn } from "./lint-check.ts";
import { TOOLS } from "./local.ts";
import { loopGuard } from "./loop-guard.ts";
import { outputCap } from "./output-cap.ts";
import { packageReadOnlyTools, packageTools, pinWebSearchProvider } from "./packages.ts";
import { PLAN_TOOLS, planStep, planStepOptions } from "./plan-step.ts";
import { rules } from "./rules.ts";
import { parseSampling, sampling } from "./sampling.ts";
import { summaryGoal, summaryGoalOn } from "./summary-goal.ts";
import { webNotes, webNotesOn } from "./web-notes.ts";

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
		if (work.includes("web_fetch") && fetchGuardOn(env)) fetchGuard(pi);
		if (work.includes("web_fetch") && webNotesOn(env)) webNotes(pi);
		if (lintOn(env)) lintCheck(pi);
		sampling(pi, parseSampling(env.NERD_SAMPLING));
		if (doneGateOn(env)) doneGate(pi, { maxRounds: doneGateRounds(env) });
		outputCap(pi, env);
		if (anchorsOn(env)) anchors(pi, env);
		if (summaryGoalOn(env)) summaryGoal(pi, work.includes("vcc_recall"));
		rules(pi, env);
		const opts = planStepOptions(operator, work, env, planTools(env));
		if (opts) planStep(pi, opts);
	};
}
