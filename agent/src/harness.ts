// What the harness does around the model in both modes (ticket 043): the
// questions-and-plan step at the start of a task (plan-step.ts), the loop
// guard (loop-guard.ts), the fetch guard (fetch-guard.ts), the linters
// after every edit (lint-check.ts), long bash output cut to head and tail
// (output-cap.ts), web pages kept in notes/web/ (web-notes.ts), the anchors
// after a compaction (anchors.ts, ticket 057 of the process), the done gate
// (done-gate.ts), the plan's steps done by their checks after each commit (step-log.ts,
// NERD_STEPS=1), the sampling settings of every request (sampling.ts,
// NERD_SAMPLING), the operator's rules for every project (rules.ts) and the
// compaction summary's goal set to the task (summary-goal.ts; process ticket
// 061), earlier steps' thinking out of each request (thinking-keep.ts,
// NERD_THINKING_KEEP=N), the work's wall clock per turn (work-budget.ts, NERD_WORK_MAX_MINUTES), the guard
// against arithmetic done by hand (calc-guard.ts, NERD_CALC=1), the plan
// step's calculator (plan-calc.ts, NERD_PLAN_CALC=1), the scout (scout.ts, NERD_SCOUT=1,
// headless), and with
// the Ralph loop (ralph.ts, decision 0014; NERD_RALPH=0 = off). The
// TUI loads it from
// extension.ts, the headless run through headless.ts.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { agoraChannelPath, SEND_LETTER_TOOL } from "./agora-channel.ts";
import { anchors, anchorsOn } from "./anchors.ts";
import { calcGuard } from "./calc-guard.ts";
import { doneGate, doneGateOn, doneGateRounds } from "./done-gate.ts";
import { fetchGuard, fetchGuardOn } from "./fetch-guard.ts";
import { lintCheck, lintOn } from "./lint-check.ts";
import { calcOn, TOOLS } from "./local.ts";
import { loopGuard } from "./loop-guard.ts";
import { outputCap } from "./output-cap.ts";
import { packageReadOnlyTools, packageTools, pinWebSearchProvider } from "./packages.ts";
import { CALC_TOOL, planCalcOn } from "./plan-calc.ts";
import { PLAN_TOOLS, planStep, planStepOptions } from "./plan-step.ts";
import { ralph, ralphOn, ralphOptions } from "./ralph.ts";
import { repeatGuard, repeatGuardOn } from "./repeat-guard.ts";
import { rules } from "./rules.ts";
import { SCOUT_TOOL, scoutOn } from "./scout.ts";
import { stepLog, stepsOn } from "./step-log.ts";
import { parseSampling, sampling } from "./sampling.ts";
import { summaryGoal, summaryGoalOn } from "./summary-goal.ts";
import { thinkingKeep, thinkingKeepExtension } from "./thinking-keep.ts";
import { webNotes, webNotesOn } from "./web-notes.ts";
import { workBudget, workMaxMinutes } from "./work-budget.ts";

/** The scout (scout.ts, NERD_SCOUT=1): headless only — its helper is a session of the run. */
function scoutTools(env: NodeJS.ProcessEnv, headless: boolean): string[] {
	return headless && scoutOn(env) ? [SCOUT_TOOL] : [];
}

/** The work's tools: ours plus those of the enabled Pi packages (packages.ts), and send_letter with an agora channel. */
export function workTools(env = process.env, headless = false): string[] {
	return [...TOOLS, ...packageTools(env), ...scoutTools(env, headless), ...(agoraChannelPath(env) ? [SEND_LETTER_TOOL] : [])];
}

/** The plan turn's tools: reading only, the packages' read-only ones included, calc with NERD_PLAN_CALC=1, the scout. */
export function planTools(env = process.env, headless = false): string[] {
	return [...PLAN_TOOLS, ...packageReadOnlyTools(env), ...(planCalcOn(env) ? [CALC_TOOL] : []), ...scoutTools(env, headless)];
}

/** Every tool either step may switch on: what Pi must have registered (--tools). */
export function allTools(env = process.env, headless = false): string[] {
	return [...new Set([...workTools(env, headless), ...planTools(env, headless)])];
}

/** What the headless run needs from the extensions (run.ts). */
export interface HarnessHooks {
	/** The steer after a cut reply, once: the repeat guard's (repeat-guard.ts) or the work clock's (work-budget.ts). */
	takeSteer?: () => string | undefined;
}

/** `operator`: a person answers in this session (TUI), or not (headless). */
export function harness(operator: boolean, env = process.env, hooks: HarnessHooks = {}): ExtensionFactory {
	return (pi) => {
		const steers: (() => string | undefined)[] = [];
		hooks.takeSteer = () => {
			for (const take of steers) {
				const s = take();
				if (s) return s;
			}
			return undefined;
		};
		if (repeatGuardOn(env)) steers.push(repeatGuard(pi, { operator }).takeSteer);
		if (calcOn(env)) steers.push(calcGuard(pi, { operator }).takeSteer);
		// The read-only tools are registered for the plan step only; the work
		// declares its own tools alone, as before.
		const work = workTools(env, !operator);
		pi.on("session_start", () => pi.setActiveTools(work));
		loopGuard(pi);
		if (work.includes("web_search")) pinWebSearchProvider(pi);
		if (work.includes("web_fetch") && fetchGuardOn(env)) fetchGuard(pi);
		if (work.includes("web_fetch") && webNotesOn(env)) webNotes(pi);
		if (lintOn(env)) lintCheck(pi);
		sampling(pi, parseSampling(env.NERD_SAMPLING));
		if (doneGateOn(env)) doneGate(pi, { maxRounds: doneGateRounds(env) });
		if (stepsOn(env)) stepLog(pi);
		outputCap(pi, env);
		if (anchorsOn(env)) anchors(pi, env);
		if (summaryGoalOn(env)) summaryGoal(pi, work.includes("vcc_recall"));
		const keepThinking = thinkingKeep(env);
		if (keepThinking !== undefined) thinkingKeepExtension(pi, keepThinking);
		rules(pi, env);
		// The Ralph loop: by events in the TUI; the headless run drives it itself (run.ts).
		if (operator && ralphOn(env)) ralph(pi, ralphOptions(env));
		// Before the plan step, so that a new task's plan tools come after the work's tools are given back.
		const workMinutes = workMaxMinutes(env);
		if (workMinutes > 0) steers.push(workBudget(pi, { maxMinutes: workMinutes, workTools: work, operator }).takeSteer);
		const opts = planStepOptions(operator, work, env, planTools(env, !operator));
		if (opts) planStep(pi, opts);
	};
}
