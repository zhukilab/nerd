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

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export function planStepPrompt(checks = process.env.NERD_RALPH === "1"): string {
	// The first version asked for QUESTIONS straight away, and the model
	// answered "none" to an open request (run 1 of ticket 043). Listing the
	// choices it would otherwise guess comes first now; the questions are
	// picked from that list. With the Ralph loop (ralph.ts) every DONE WHEN item
	// carries the command the harness runs to check it (done-when.ts).
	const done = checks
		? `- <what the operator can do and see when it is finished> — check: \`<a shell command, run from the project root in a clean clone, that exits 0 only if this is true>\`
(one item per requirement of the request; a claim of quality — harder, faster, correct rules, fits a phone — gets a command that measures it, e.g. plays many games between neighbouring levels, or opens the page with \`browse\` and finds the text; a fact from the web goes into the README as \`> "<the page's exact words>" — notes/web/<file>.md\`, and the harness checks the words against that saved page)`
		: "- <what the operator can do and see when it is finished>";
	return `[harness] A new task. This turn is for questions and a plan only: you can read files, not change them.
Reply in exactly this form:
ASSUMPTIONS
- <each choice the request leaves open that you would otherwise make by guessing>
QUESTIONS
- <a short question for each assumption the operator would want to decide>   (or the single word: none)
PLAN
1. <step> — check: <how you will check it>
DONE WHEN
${done}`;
}

export function finalPlanPrompt(answer?: string): string {
	const a = answer === undefined ? "" : `The operator's answer: ${answer}\n`;
	return `${a}[harness] Now the final plan in the same form, with PLAN and DONE WHEN and no QUESTIONS. Files still cannot be changed in this turn.`;
}

export function workPrompt(saved: string): string {
	return `[harness] ${saved} All tools are available again. Carry out the plan step by step, checking each step as it says.`;
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
		if (!existsSync(join(cwd, ".git"))) git("init", "-q");
		git("add", PLAN_FILE);
		git("commit", "-q", "-m", "Plan", "--", PLAN_FILE);
		return `Your plan is saved in ${PLAN_FILE} and committed.`;
	} catch (e) {
		const why = e instanceof Error ? (e as { stderr?: Buffer }).stderr?.toString().trim() || e.message : String(e);
		return `Your plan is saved in ${PLAN_FILE} (not committed: ${why.split("\n")[0]}).`;
	}
}

type Msg = { role?: string; content?: unknown };

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
}

export function planStepOptions(
	operator: boolean,
	workTools: string[],
	env = process.env,
	planTools: string[] = PLAN_TOOLS,
): PlanStepOptions | undefined {
	if (env.NERD_PLAN_STEP === "0") return undefined;
	return { operator, workTools, planTools, maxCalls: planMaxCalls(env), answer: env.NERD_PLAN_ANSWER || DEFAULT_PLAN_ANSWER };
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
			pi.setActiveTools(opts.planTools);
			return { message: { customType: "nerd-plan", content: planStepPrompt(), display: true } };
		}
		if (phase === "plan") {
			// The operator's answer to the questions (or any reply to them).
			phase = "answered";
			answer = event.prompt;
			return { message: { customType: "nerd-plan", content: finalPlanPrompt(), display: true } };
		}
		return;
	});

	// The budget: counted over the whole step (both plan turns), not per turn.
	pi.on("tool_result", (event) => {
		if (phase === "work" || opts.maxCalls <= 0) return;
		calls += 1;
		if (calls !== opts.maxCalls) return;
		pi.setActiveTools([]);
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${planBudgetNote(calls)}` }],
			structuredContent: event.structuredContent,
		};
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (phase === "work" || event.outcome !== "completed") return;
		const reply = parsePlanReply(lastAssistantText(event.context.contextMessages as Msg[]));
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
		const saved = savePlan(ctx.cwd, planFileText(task, kept, questions.length ? { questions, answer } : undefined));
		toWork();
		return {
			entries: [{ type: "custom_message" as const, customType: "nerd-plan", content: workPrompt(saved), display: true }],
			continue: true,
		};
	});
}
