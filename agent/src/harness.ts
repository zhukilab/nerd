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
// the Ralph loop (ralph.ts, decision 0014; NERD_RALPH=0 = off), and in the TUI
// the modes (mode.ts, decision 0019: conversation first, work on /plan,
// /solve, /ralph). The TUI loads it from
// extension.ts, the headless run through headless.ts.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { agoraChannelPath, SEND_LETTER_TOOL } from "./agora-channel.ts";
import { anchors, anchorsOn } from "./anchors.ts";
import { calcGuard } from "./calc-guard.ts";
import { doneGate, doneGateOn, doneGateRounds } from "./done-gate.ts";
import { fetchGuard, fetchGuardOn } from "./fetch-guard.ts";
import { lintCheck, lintOn } from "./lint-check.ts";
import { calcOn, TOOLS } from "./local.ts";
import { loopGuard, loopGuardHard } from "./loop-guard.ts";
import { reflexExtension, reflexKeepTurns, reflexOn } from "./reflex.ts";
import { sessionStatsExtension } from "./session-stats.ts";
import { checkedMode, modes, newModeState, type PlanStepHandle } from "./mode.ts";
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
import { gateCommand } from "./ralph-gate.ts";
import { summaryGoal, summaryGoalOn } from "./summary-goal.ts";
import { thinkingKeep, thinkingKeepExtension } from "./thinking-keep.ts";
import { RUNS_TOOL, runsToolOn } from "./tmux-runs.ts";
import { webNotes, webNotesOn } from "./web-notes.ts";
import { workBudget, workMaxMinutes } from "./work-budget.ts";

/** The scout (scout.ts, NERD_SCOUT=1): headless only — its helper is a session of the run. */
function scoutTools(env: NodeJS.ProcessEnv, headless: boolean): string[] {
	return headless && scoutOn(env) ? [SCOUT_TOOL] : [];
}

/** The work's tools: ours plus those of the enabled Pi packages (packages.ts), send_letter with an agora channel,
 * runs (background commands, tmux-runs.ts) with NERD_RUNS_BACKGROUND. */
export function workTools(env = process.env, headless = false): string[] {
	return [
		...TOOLS,
		...packageTools(env),
		...scoutTools(env, headless),
		...(agoraChannelPath(env) ? [SEND_LETTER_TOOL] : []),
		...(runsToolOn(env) ? [RUNS_TOOL] : []),
	];
}

/** The plan turn's tools: reading only, the packages' read-only ones included, calc with NERD_PLAN_CALC=1, the scout;
 * send_letter with an agora channel, so a letter that comes during the step can be answered (it changes no file). */
export function planTools(env = process.env, headless = false): string[] {
	return [
		...PLAN_TOOLS,
		...packageReadOnlyTools(env),
		...(planCalcOn(env) ? [CALC_TOOL] : []),
		...scoutTools(env, headless),
		...(agoraChannelPath(env) ? [SEND_LETTER_TOOL] : []),
	];
}

/** Every tool either step may switch on: what Pi must have registered (--tools). */
export function allTools(env = process.env, headless = false): string[] {
	return [...new Set([...workTools(env, headless), ...planTools(env, headless)])];
}

/** What the headless run needs from the extensions (run.ts). */
export interface HarnessHooks {
	/** The steer after a cut reply, once: the repeat guard's (repeat-guard.ts) or the work clock's (work-budget.ts). */
	takeSteer?: () => string | undefined;
	/** Whether a guard ended the last turn on purpose with no steer (loop-guard.ts, the third loop), once:
	 * the reply's "aborted" error is then the guard's, not the model server's (#1013). */
	takeEnded?: () => boolean;
	/** The next turn's work clock as the round gate set it (#978, ralph-gate.ts); the smaller of it and NERD_WORK_MAX_MINUTES counts. */
	turnMinutes?: number;
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
		// Session statistics (#993): fed by every session, the TUI's status line from it.
		sessionStatsExtension(pi, { operator });
		// The reflex by place of work (#1051): notes naming an edited file, shown once, forgotten soon.
		if (reflexOn(env)) reflexExtension(pi, { keep: reflexKeepTurns(env) });
		const lg = loopGuard(pi, { operator, hard: loopGuardHard(env) });
		steers.push(lg.takeSteer);
		hooks.takeEnded = lg.takeEnded;
		if (work.includes("web_search")) pinWebSearchProvider(pi);
		if (work.includes("web_fetch") && fetchGuardOn(env)) fetchGuard(pi);
		if (work.includes("web_fetch") && webNotesOn(env)) webNotes(pi);
		if (lintOn(env)) lintCheck(pi);
		sampling(pi, parseSampling(env.NERD_SAMPLING));
		// The modes (mode.ts, process ticket 104): in the TUI conversation first; headless, NERD_MODE.
		const mode = newModeState(operator, env);
		const step: PlanStepHandle = {};
		const reading = planTools(env, !operator);
		if (doneGateOn(env)) doneGate(pi, { maxRounds: doneGateRounds(env), active: () => checkedMode(mode) });
		if (stepsOn(env)) stepLog(pi);
		outputCap(pi, env);
		if (anchorsOn(env)) anchors(pi, env);
		if (summaryGoalOn(env)) summaryGoal(pi, work.includes("vcc_recall"));
		const keepThinking = thinkingKeep(env);
		if (keepThinking !== undefined) thinkingKeepExtension(pi, keepThinking);
		rules(pi, env);
		// Before the plan step, so that a new task's plan tools come after the work's tools are given back.
		const workMinutes = workMaxMinutes(env);
		// With a round gate (#978) the clock is there even without NERD_WORK_MAX_MINUTES: the gate may set a turn's minutes.
		const turnMinutes = () => {
			const g = hooks.turnMinutes;
			return g && g > 0 ? (workMinutes > 0 ? Math.min(g, workMinutes) : g) : workMinutes;
		};
		if (workMinutes > 0 || (!operator && gateCommand(env))) steers.push(workBudget(pi, { maxMinutes: turnMinutes, workTools: work, operator }).takeSteer);
		// After the work clock, which gives the work's tools back on a turn; before the Ralph loop, which reads
		// the turn's mode, and the plan step, which takes the tools for a new task.
		if (operator) modes(pi, mode, { planTools: reading, workTools: work, step });
		// The Ralph loop: by events in the TUI; the headless run drives it itself (run.ts).
		if (operator && ralphOn(env)) ralph(pi, ralphOptions(env), undefined, mode);
		const opts = planStepOptions(operator, work, env, reading);
		if (opts) Object.assign(step, planStep(pi, { ...opts, mode }));
	};
}
