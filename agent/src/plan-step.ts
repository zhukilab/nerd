// Questions and plan before work (ticket 043). Asked by prompt alone, the
// model never asked before coding (0 of 4 runs in ticket 038, none in the
// first acceptance run) and planned once, after the code. So the harness makes
// the first turn of a new task a separate step: the model may read but not
// change anything, and replies with its open questions and a plan. Then:
//
//   - questions: in the TUI the turn ends and the operator answers; headless,
//     the answer is NERD_PLAN_ANSWER («на твоё усмотрение» by default). The
//     model then gives the final plan, still without write tools;
//   - no questions (or after the answer): the harness writes the plan into
//     PLAN.md, commits it (git init if needed), gives the tools back and the
//     run goes on with the work in the same turn.
//
// A new task is the first user message of a session, or one sent with
// `/task <text>` in the TUI. Any other message is a remark within the task.
// NERD_PLAN_STEP=0 turns the step off.
//
// The step has a budget of tool calls (ticket 054). Unbounded, the model kept
// reading and searching the web in it for hours and never replied: 26 of 60
// runs of the A/B in ticket 048 timed out there after 460-3672 calls, while
// 31 of the 34 runs that replied did so within 30 (median 8). At the
// NERD_PLAN_MAX_CALLS-th call (default 40; 0 = no budget) a note asks for the
// plan now and the tools are taken away, so the next reply is text and the
// step ends with whatever plan it holds.
//
// NERD_PLAN_CALC=1 adds a calculator to the step's tools (plan-calc.ts, process ticket 094): it
// runs a Python program and changes nothing in the project.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pairOn, pairSwitch, type Role } from "./pair.ts";
import { CALC_TOOL, outputNumbers, planCalcLintOn, planCalcNote } from "./plan-calc.ts";
import { lintPlan, lintRetryMessage, lintSection, ownInputOn, planLintOn } from "./plan-lint.ts";
import { isCargoProject } from "./cargo.ts";

/** Tools of the questions-and-plan turn: reading only. */
export const PLAN_TOOLS = ["read", "ls", "grep", "find"];
export const DEFAULT_PLAN_ANSWER = "на твоё усмотрение";
export const PLAN_FILE = "PLAN.md";
export const DEFAULT_PLAN_MAX_CALLS = 40;

export function planMaxCalls(env = process.env): number {
	const raw = env.NERD_PLAN_MAX_CALLS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_PLAN_MAX_CALLS;
	const v = Number(raw);
	return Number.isInteger(v) && v >= 0 ? v : DEFAULT_PLAN_MAX_CALLS;
}

export function planBudgetNote(calls: number): string {
	return (
		`[harness] That was call ${calls} of this questions-and-plan turn: its budget is spent and the tools are put away. ` +
		"Reply now, without tools, with the plan in the form asked for, from what you already know; " +
		"what you could not find out goes under ASSUMPTIONS. The work, with all tools, starts after the plan."
	);
}

/** A Rust task: a Cargo project here, or the task names Rust or cargo (process ticket 090). */
export function rustTask(cwd: string, task: string): boolean {
	return isCargoProject(cwd) || /\b(rust|cargo)\b/i.test(task);
}

const RUST_CHECKS =
	"\nIn Rust, a library's behaviour is checked with `nerd-rs-eval '<Rust statements>'` — it runs them with the crate's items in scope and fails when an assert! fails, e.g. `nerd-rs-eval 'assert_eq!(f(\"in\"), \"out\");'` (the program in single quotes) — and a binary's with `cargo run -q -- <args> | grep -qx <output>`; `cargo test` alone runs only the tests the work writes itself.";

/** `note`: the calculator's stimulus (plan-calc.ts, NERD_PLAN_CALC_NOTE), after the form. */
/** The plan form asks for check commands when the Ralph loop runs them: ralphOn (ralph.ts imports this file). */
export function checksOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_RALPH !== "0";
}

export function planStepPrompt(checks = checksOn(), rust = false, note = ""): string {
	// The first version asked for QUESTIONS straight away, and the model
	// answered "none" to an open request (run 1 of ticket 043). Listing the
	// choices it would otherwise guess comes first now; the questions are
	// picked from that list. With the Ralph loop (ralph.ts) every DONE WHEN item
	// carries the command the harness runs to check it (done-when.ts).
	const done = checks
		? `- <what the operator can do and see when it is finished> — check: \`<a shell command, run from the project root in a clean clone, that exits 0 only if this is true>\`
(one item per requirement of the request, its command on that one line; only the exit code counts, so a command that prints must also fail when the output is wrong — \`| grep -q "<text>"\`, \`process.exit(ok ? 0 : 1)\`, \`assert\`; a claim of quality — harder, faster, correct rules, fits a phone — gets a command that measures it, e.g. plays many games between neighbouring levels, or \`browse <url> | grep -q "<text on the page>"\`; a fact from the web goes into the README as \`> "<the page's exact words>" — notes/web/<file>.md\`, and the harness checks the words against that saved page)`
		: "- <what the operator can do and see when it is finished>";
	const rs = checks && rust ? RUST_CHECKS : "";
	return `[harness] A new task. This turn is for questions and a plan only: you can read files, not change them.
Reply in exactly this form:
ASSUMPTIONS
- <each choice the request leaves open that you would otherwise make by guessing>
QUESTIONS
- <a short question for each assumption the operator would want to decide>   (or the single word: none)
PLAN
1. <step> — check: <how you will check it>
DONE WHEN
${done}${rs}${note ? `\n\n${note}` : ""}`;
}

export function finalPlanPrompt(answer?: string): string {
	const a = answer === undefined ? "" : `The operator's answer: ${answer}\n`;
	return `${a}[harness] Now the final plan in the same form, with PLAN and DONE WHEN and no QUESTIONS. Files still cannot be changed in this turn.`;
}

export function workPrompt(saved: string): string {
	return `[harness] ${saved} All tools are available again. Carry out the plan step by step, checking each step as it says.`;
}

/**
 * Tool calls the model wrote as text (`<tool_call><function=read>…`), cut out of a
 * reply, with the names of the tools it tried (ticket 070). After the call budget
 * the tools are put away, and the model went on "calling" them as text: 4 of 20
 * plans on the plan-only stand of ticket 065, and 25 of 184 earlier plans, were
 * such a call instead of a plan (one was a plan with a call after it).
 */
export function stripToolCalls(text: string): { text: string; calls: string[] } {
	const calls: string[] = [];
	const name = (m: string) => {
		const f = /<function=([\w.-]+)/.exec(m);
		if (f) calls.push(f[1]);
		return "";
	};
	const cut = text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, name).replace(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g, name);
	return { text: cut.trim(), calls };
}

export function toolTextNote(calls: string[]): string {
	const names = [...new Set(calls)].map((c) => `\`${c}\``).join(", ");
	return (
		`[harness] You wrote a call to ${names} as text. The tools of this turn are put away, so a call written as text is not run and nothing comes back. ` +
		"Reply now, without tools, with the plan in the form asked for (PLAN, then DONE WHEN), from what you already know; what you could not find out goes under ASSUMPTIONS."
	);
}

/** Direct notes about tool calls written as text, per task, before the reply is taken as it is. */
const TOOL_TEXT_NOTES = 2;

// Ticket 071: one reply of the plan step went on re-drafting the plan ("Hmm…
// actually, wait…") for 40 minutes, 42 thousand characters, never the same text
// twice; the longest plan of 184 earlier ones is about 3 thousand tokens. So the
// step's requests carry their own max_tokens, and a reply cut there gives its last
// complete draft. (Aborting the stream instead ends Pi's whole run.)
// With thinking on there is no such default (ticket 077): the thinking counts
// into the same max_tokens, and Bonsai 2 at "medium" spent all 6144 before the
// plan, 3-4 replies cut in a row in every run, 22-30 min of 48-81 lost.
export const DEFAULT_PLAN_MAX_TOKENS = 6144;
// Process ticket 089: with no cap at all under thinking, one reply of the step ran 63 min
// (93 thousand characters of thinking), another 91 min; three in a row were cut only by the
// end of the context window, with no text, and a plan without steps or checks got frozen.
// Three runs of 21 never left the step in 5 h. So thinking gets a cap too, wide enough for the
// plans that did come — the thinking of the 35 replies there that gave a plan: median 7.5,
// p90 31, max 66 thousand characters (~17 thousand tokens); the cap is ~98 thousand — and a
// reply cut without a draft is answered by one more request with thinking off.
export const DEFAULT_PLAN_MAX_TOKENS_THINKING = 24576;
const DRAFT_NOTES = 2;

export function planMaxTokens(env = process.env): number {
	const raw = env.NERD_PLAN_MAX_TOKENS;
	const thinking = (env.NERD_THINKING ?? "off") !== "off";
	const dflt = thinking ? DEFAULT_PLAN_MAX_TOKENS_THINKING : DEFAULT_PLAN_MAX_TOKENS;
	if (raw === undefined || raw.trim() === "") return dflt;
	const v = Number(raw);
	return Number.isInteger(v) && v >= 0 ? v : dflt;
}

// The step's wall-clock budget (process ticket 089: 160-280 min in the step in five runs).
// Past it the tools are put away as at the call budget, and requests go with thinking off,
// so the next reply is the plan. 0: no budget.
export const DEFAULT_PLAN_MAX_MINUTES = 45;

export function planMaxMinutes(env = process.env): number {
	const raw = env.NERD_PLAN_MAX_MINUTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_PLAN_MAX_MINUTES;
	const v = Number(raw);
	return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PLAN_MAX_MINUTES;
}

export function planTimeNote(minutes: number): string {
	return (
		`[harness] This questions-and-plan turn has run ${minutes} minutes, its time budget: the tools are put away. ` +
		"Reply now, without tools and without further deliberation, with the plan in the form asked for, from what you already know; " +
		"what you could not find out goes under ASSUMPTIONS. The work, with all tools, starts after the plan."
	);
}

/** Thinking off for one request: the chat-template switch (llama.cpp) and the top-level one (mlx). */
export function withoutThinking(p: Record<string, unknown>): Record<string, unknown> {
	const kw = typeof p.chat_template_kwargs === "object" && p.chat_template_kwargs ? (p.chat_template_kwargs as Record<string, unknown>) : {};
	return { ...p, chat_template_kwargs: { ...kw, enable_thinking: false }, enable_thinking: false };
}

/** The last draft in a reply that has a PLAN and a DONE WHEN with items, up to its last item; undefined: none. */
export function lastDraft(text: string): string | undefined {
	const starts = [...text.matchAll(new RegExp(heading("PLAN").source, "gim"))].map((m) => m.index ?? 0);
	for (let k = starts.length - 1; k >= 0; k--) {
		const lines = text.slice(starts[k], starts[k + 1] ?? text.length).split("\n");
		const done = lines.findIndex((l) => heading("DONE WHEN").test(l));
		if (done < 0) continue;
		let last = -1;
		for (let j = done + 1; j < lines.length; j++) {
			if (/^\s*[-*]\s+\S/.test(lines[j])) last = j;
			else if (lines[j].trim() && last >= 0) break;
		}
		if (last >= 0) return lines.slice(0, last + 1).join("\n").trim();
	}
	return undefined;
}

export function draftNote(maxTokens: number): string {
	// "(0 tokens)" was what it said with no cap (process ticket 089): the reply had filled the window.
	const limit = maxTokens > 0 ? `the plan step's length budget (${maxTokens} tokens)` : "the length limit";
	return (
		`[harness] Your reply reached ${limit} before it held a complete plan. ` +
		"Give the final plan now, once, in the form asked for (PLAN, then DONE WHEN), with short items and no deliberation before it."
	);
}

export interface PlanReply {
	/** The ASSUMPTIONS section as written, without its heading ("" when absent). */
	assumptions: string;
	questions: string[];
	/** The reply from PLAN on (or the whole reply when there is no PLAN heading). */
	plan: string;
}

/** A heading line: the word alone, or followed by a colon ("QUESTIONS: none"), in any markdown dress. */
const heading = (words: string) => new RegExp(`^[ \\t#*_>]*${words}[ \\t*_]*(:[ \\t*_]*|$)`, "im");
const NONE = /^[-*\d.\s()]*(none|нет|no questions)[.)]?$/i;

/** Splits the model's reply into its assumptions, open questions and plan. */
export function parsePlanReply(text: string): PlanReply {
	const a = heading("ASSUMPTIONS").exec(text);
	const q = heading("QUESTIONS").exec(text);
	const p = heading("PLAN").exec(text);
	const plan = p ? text.slice(p.index).trim() : text.trim();
	const after = (m: RegExpExecArray) => [q, p].filter((h) => h && h.index > m.index).map((h) => h!.index);
	const assumptions = a ? text.slice(a.index + a[0].length, Math.min(text.length, ...after(a))).trim() : "";
	// Under a QUESTIONS heading every item is a question; without one, only
	// lines ending in "?" before the plan are.
	const qText = q
		? text.slice(q.index + q[0].length, Math.min(text.length, ...after(q)))
		: text.slice(a ? Math.min(text.length, ...after(a)) : 0, p ? p.index : undefined);
	const questions = qText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !NONE.test(l))
		.filter((l) => q !== null || l.endsWith("?"))
		.map((l) => l.replace(/^[-*]\s+|^\d+[.)]\s+/, ""));
	return { assumptions, questions, plan };
}

export function planFileText(
	task: string,
	reply: Pick<PlanReply, "assumptions" | "plan">,
	qa?: { questions: string[]; answer: string },
): string {
	const quoted = task
		.trim()
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	const assumed = reply.assumptions ? `\n## Assumptions\n\n${reply.assumptions}\n` : "";
	const asked = qa?.questions.length
		? `\n## Questions\n\n${qa.questions.map((q) => `- ${q}`).join("\n")}\n\nAnswer: ${qa.answer}\n`
		: "";
	const body = reply.plan
		.replace(heading("PLAN"), "## Steps\n")
		.replace(heading("DONE WHEN"), "\n## Done when\n");
	return `# Plan\n\n## Task\n\n${quoted}\n${assumed}${asked}\n${body}\n`;
}

/** Writes PLAN.md into cwd and commits it; returns what to tell the model. */
export function savePlan(cwd: string, text: string): string {
	writeFileSync(join(cwd, PLAN_FILE), text);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	try {
		// A repository made here starts with the project as it was given, so the work's diff
		// is the work's and the done gate does not report the given files as uncommitted.
		// Process ticket 089: the first Ralph round of a run that began this way was always
		// "Uncommitted changes: lib/, package.json, test/" — once at the 263rd minute.
		// A repository that was already there is not ours to commit in.
		if (!existsSync(join(cwd, ".git"))) {
			git("init", "-q");
			git("add", "-A", "--", ".", `:!${PLAN_FILE}`, ":!node_modules", ":!target");
			if (git("diff", "--cached", "--name-only").toString().trim()) git("commit", "-q", "-m", "Project as given");
		}
		git("add", PLAN_FILE);
		git("commit", "-q", "-m", "Plan", "--", PLAN_FILE);
		return `Your plan is saved in ${PLAN_FILE} and committed.`;
	} catch (e) {
		const why = e instanceof Error ? (e as { stderr?: Buffer }).stderr?.toString().trim() || e.message : String(e);
		return `Your plan is saved in ${PLAN_FILE} (not committed: ${why.split("\n")[0]}).`;
	}
}

type Msg = { role?: string; content?: unknown };

function lastStopReason(messages: Msg[]): string | undefined {
	return ([...messages].reverse().find((x) => x.role === "assistant") as { stopReason?: string } | undefined)?.stopReason;
}

function lastAssistantText(messages: Msg[]): string {
	const m = [...messages].reverse().find((x) => x.role === "assistant");
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	return Array.isArray(m.content)
		? m.content
				.filter((c: { type?: string }) => c.type === "text")
				.map((c: { text?: string }) => c.text ?? "")
				.join("\n")
		: "";
}

export interface PlanStepOptions {
	/** A person answers questions (TUI); otherwise `answer` is given for them. */
	operator: boolean;
	answer?: string;
	/** The tools of the work, given back after the plan. */
	workTools: string[];
	/** The tools of the plan turn: PLAN_TOOLS and the packages' read-only ones. */
	planTools: string[];
	/** Tool calls allowed in the plan turn before the tools are taken away (0: no budget). */
	maxCalls: number;
	/** plan-lint (plan-lint.ts) on the final plan: one retry on errors. */
	lint: boolean;
	/** NERD_PLAN_LINT_OWN_INPUT=1: a behavior check on an input not in the task (plan-lint.ts). */
	ownInput?: boolean;
	/** The plan form asks for check commands (the Ralph loop). */
	checks: boolean;
	/** max_tokens of the step's requests (0: as the model's). */
	maxTokens: number;
	/** The step's wall-clock budget in minutes (0: none). */
	maxMinutes: number;
	/** The ping-pong pair (pair.ts): the planner's model writes the plan, the session's the work. */
	pair: boolean;
	/** NERD_PLAN_CALC_NOTE: the calculator's stimulus in the step's prompt (plan-calc.ts). */
	calcNote?: string;
	/** NERD_PLAN_CALC_LINT=1: plan-lint wants the checks' numbers printed by calc (plan-calc.ts). */
	calcLint?: boolean;
}

export function planStepOptions(
	operator: boolean,
	workTools: string[],
	env = process.env,
	planTools: string[] = PLAN_TOOLS,
): PlanStepOptions | undefined {
	if (env.NERD_PLAN_STEP === "0") return undefined;
	return {
		operator,
		workTools,
		planTools,
		maxCalls: planMaxCalls(env),
		answer: env.NERD_PLAN_ANSWER || DEFAULT_PLAN_ANSWER,
		lint: planLintOn(env),
		ownInput: ownInputOn(env),
		checks: checksOn(env),
		maxTokens: planMaxTokens(env),
		maxMinutes: planMaxMinutes(env),
		pair: pairOn(env),
		calcNote: planCalcNote(env),
		calcLint: planCalcLintOn(env),
	};
}

/**
 * The step as a Pi extension. Phases: "work" (normal), "plan" (the first
 * turn of a task), "answered" (questions asked, the final plan is next).
 */
export function planStep(pi: ExtensionAPI, opts: PlanStepOptions) {
	let phase: "work" | "plan" | "answered" = "work";
	let task = "";
	let questions: string[] = [];
	let assumptions = "";
	let answer = "";
	let explicitTask = false;
	let calls = 0;
	let linted = false;
	let toolNotes = 0;
	let draftNotes = 0;
	let startedAt = 0;
	let timeNoted = false;
	let rust = false;
	// What the step's calc calls printed, for plan-lint's mechanism M (plan-calc.ts).
	let calcOutputs: string[] = [];
	// The next requests go with thinking off: a reply was cut with no plan in it, or the time is up.
	let quick = false;
	const overTime = (now = Date.now()) => opts.maxMinutes > 0 && startedAt > 0 && now - startedAt >= opts.maxMinutes * 60_000;

	// With the pair a handler waits for the model switch; without it, it stays synchronous.
	const role = opts.pair ? pairSwitch(pi) : undefined;
	const as = <T>(r: Role, ctx: ExtensionContext, result: T): T | Promise<T> => (role ? role(r, ctx).then(() => result) : result);
	const toWork = () => {
		phase = "work";
		pi.setActiveTools(opts.workTools);
	};

	pi.on("session_start", () => {
		phase = "work";
	});

	pi.registerCommand("task", {
		description: "Start a new task: questions and a plan first, then the work (ticket 043)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("task: give the task text", "error");
				return;
			}
			explicitTask = true;
			pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const earlier = ctx.sessionManager
			.getBranch()
			.some((e: { type?: string; message?: Msg }) => e.type === "message" && e.message?.role === "user");
		if (explicitTask || !earlier) {
			explicitTask = false;
			phase = "plan";
			task = event.prompt;
			questions = [];
			assumptions = "";
			answer = "";
			calls = 0;
			linted = false;
			toolNotes = 0;
			draftNotes = 0;
			startedAt = Date.now();
			timeNoted = false;
			quick = false;
			calcOutputs = [];
			rust = rustTask(ctx.cwd || process.cwd(), task);
			pi.setActiveTools(opts.planTools);
			return as("planner", ctx, { message: { customType: "nerd-plan", content: planStepPrompt(opts.checks, rust, opts.calcNote), display: true } });
		}
		if (phase === "plan") {
			// The operator's answer to the questions (or any reply to them).
			phase = "answered";
			answer = event.prompt;
			return { message: { customType: "nerd-plan", content: finalPlanPrompt(), display: true } };
		}
		return;
	});

	pi.on("before_provider_request", (event) => {
		if (phase === "work") return;
		let p = event.payload as Record<string, unknown> | undefined;
		if (!p || typeof p !== "object") return;
		if (overTime()) quick = true;
		if (quick) p = withoutThinking(p);
		if (opts.maxTokens <= 0) return quick ? p : undefined;
		const now = typeof p.max_tokens === "number" ? p.max_tokens : Infinity;
		return now > opts.maxTokens ? { ...p, max_tokens: opts.maxTokens } : p;
	});

	// The budgets: calls counted over the whole step (both plan turns), not per turn; time from its start.
	pi.on("tool_result", (event) => {
		if (phase === "work") return;
		calls += 1;
		if (event.toolName === CALC_TOOL && !event.isError) {
			calcOutputs.push(event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
		}
		let note: string | undefined;
		if (opts.maxCalls > 0 && calls === opts.maxCalls) note = planBudgetNote(calls);
		else if (!timeNoted && overTime()) note = planTimeNote(opts.maxMinutes);
		if (!note) return;
		timeNoted = true;
		quick ||= overTime();
		pi.setActiveTools([]);
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${note}` }],
			structuredContent: event.structuredContent,
		};
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (phase === "work" || event.outcome !== "completed") return;
		const messages = event.context.contextMessages as Msg[];
		const said = stripToolCalls(lastAssistantText(messages));
		// A reply with several drafts gives its last complete one; so does a reply cut
		// at the cap. (A PLAN.md once kept two drafts, and its first Done when, the one
		// without commands, was what got read.) The assumptions are read from it all.
		const cut = lastStopReason(messages) === "length";
		const drafts = [...said.text.matchAll(new RegExp(heading("PLAN").source, "gim"))].length;
		let draft: string | undefined;
		// An empty reply is no plan either (process ticket 089: three cut replies in a row had
		// no text at all, and the third was frozen as a plan without steps or checks).
		const empty = !said.text.trim() && !said.calls.length;
		if (cut || drafts > 1 || empty) {
			draft = lastDraft(said.text);
			if (!draft && (cut || empty) && draftNotes < DRAFT_NOTES) {
				draftNotes += 1;
				quick = true; // the next reply without thinking: thinking is what filled the cut one
				return {
					entries: [{ type: "custom_message" as const, customType: "nerd-plan", content: draftNote(opts.maxTokens), display: true }],
					continue: true,
				};
			}
		}
		if (said.calls.length && !heading("PLAN").test(said.text) && toolNotes < TOOL_TEXT_NOTES) {
			toolNotes += 1;
			return {
				entries: [{ type: "custom_message" as const, customType: "nerd-plan", content: toolTextNote(said.calls), display: true }],
				continue: true,
			};
		}
		const reply = parsePlanReply(said.text);
		if (draft) reply.plan = draft;
		if (phase === "plan" && reply.questions.length) {
			questions = reply.questions;
			assumptions = reply.assumptions;
			if (opts.operator) return; // the turn ends; the operator answers
			phase = "answered";
			answer = opts.answer ?? DEFAULT_PLAN_ANSWER;
			return {
				entries: [{ type: "custom_message" as const, customType: "nerd-plan", content: finalPlanPrompt(answer), display: true }],
				continue: true,
			};
		}
		// The final plan may leave out the assumptions it was asked about.
		const kept = { assumptions: reply.assumptions || assumptions, plan: reply.plan };
		let text = planFileText(task, kept, questions.length ? { questions, answer } : undefined);
		if (opts.lint) {
			// plan-lint (ticket 065): errors go back once, before the plan is frozen.
			const calcPrinted = opts.calcLint ? outputNumbers(calcOutputs) : undefined;
			const findings = lintPlan(text, { checks: opts.checks, ownInput: opts.ownInput, rust, calcPrinted });
			const errors = findings.filter((f) => f.severity === "error");
			if (errors.length && !linted) {
				linted = true;
				assumptions = kept.assumptions;
				phase = "answered";
				return {
					entries: [{ type: "custom_message" as const, customType: "nerd-plan-lint", content: lintRetryMessage(findings), display: true }],
					continue: true,
				};
			}
			text += lintSection(errors);
		}
		const saved = savePlan(ctx.cwd, text);
		toWork();
		return as("worker", ctx, {
			entries: [{ type: "custom_message" as const, customType: "nerd-plan", content: workPrompt(saved), display: true }],
			continue: true,
		});
	});
}
