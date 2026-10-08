// The goal in pi-vcc's compaction summary, set right (process ticket 061).
// pi-vcc builds "[Session Goal]" from the user messages it keeps: lines over
// 200 characters are dropped, so a one-line task (0006: 300+) is lost, and what
// stays is the plan step's answer form ("Reply in exactly this form:
// ASSUMPTIONS ...") and the operator's answers. In the 0006 run on main an
// early assumption with the wrong cycle outlived the code that fixed it and
// reached the page (ticket 049). And it tells the model to use vcc_recall,
// which is no longer offered (packages.ts).
//
// Before every model call the summary message is rewritten, the same way
// every time (the prefix cache keeps working): the goal is the task in the
// operator's words, pointing at PLAN.md for the decisions; the vcc_recall line
// goes when the tool is not offered. Nothing in the session file changes.
// NERD_SUMMARY_GOAL=0 leaves the summary as pi-vcc wrote it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_MAX = 1200;

export function summaryGoalOn(env = process.env): boolean {
	return env.NERD_SUMMARY_GOAL !== "0";
}

/**
 * The summary with its [Session Goal] section replaced by the task, the plan
 * step's form and assumptions taken out of its transcript, and the recall hint
 * dropped unless kept.
 */
export function fixSummary(summary: string, task: string | undefined, keepRecall: boolean): string {
	let out = summary;
	if (task?.trim()) {
		const t = task.trim().length > GOAL_MAX ? `${task.trim().slice(0, GOAL_MAX)} […]` : task.trim();
		const goal =
			`[Session Goal]\n- The task, in the operator's words: ${t.replace(/\n+/g, " ")}\n` +
			"- Decisions, answers and steps: PLAN.md (the assumptions made before the answers are not decisions).";
		out = /^\[Session Goal\][^\n]*\n/m.test(out)
			? out.replace(/^\[Session Goal\][^\n]*\n(?:(?!\n|\[)[^\n]*\n)*/m, `${goal}\n`)
			: `${goal}\n\n${out}`;
	}
	// The transcript part keeps the plan step's exchange too: its form and the
	// model's ASSUMPTIONS, made before the operator answered (in 0006 on main the
	// wrong cycle travelled exactly so). The block goes, up to the next heading
	// of the form, a section or a blank line; PLAN.md holds what was decided.
	out = out.replace(/^Reply in exactly this form:\n/gm, "");
	out = out.replace(
		/^ASSUMPTIONS:?[ \t]*\n(?:(?!(?:QUESTIONS|PLAN|DONE WHEN)\b)(?!\[)[^\n]+\n)*/gm,
		"(assumptions made before the operator's answers left out: PLAN.md has the decisions)\n",
	);
	// The hint is a paragraph (it wraps): it goes up to the next blank line.
	if (!keepRecall) out = out.replace(/^[^\n]*vcc_recall[^\n]*\n(?:[^\n]+\n)*\n?/gm, "");
	return out;
}

type Msg = { role?: string; summary?: string; content?: unknown };
type Entry = { type?: string; message?: Msg };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: { type?: string }) => c.type === "text")
		.map((c: { text?: string }) => c.text ?? "")
		.join("\n");
}

/** As a Pi extension: the summary rewritten in each request's context. */
export function summaryGoal(pi: ExtensionAPI, keepRecall: boolean) {
	pi.on("context", (event, ctx) => {
		const msgs = event.messages as Msg[];
		if (!msgs.some((m) => m.role === "compactionSummary")) return;
		const first = (ctx.sessionManager.getBranch() as Entry[]).find((e) => e.type === "message" && e.message?.role === "user");
		const task = textOf(first?.message?.content) || undefined;
		const messages = msgs.map((m) =>
			m.role === "compactionSummary" && typeof m.summary === "string" ? { ...m, summary: fixSummary(m.summary, task, keepRecall) } : m,
		);
		return { messages: messages as typeof event.messages };
	});
}
