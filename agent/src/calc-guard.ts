// The calc guard (process ticket 090, stage 3; operator, 2026-10-17). In the tax runs 11-32% of
// Bonsai's thinking was arithmetic done by hand — "2 547 500 * 0.25 = 636 875" line after line,
// 20-30 minutes in one reply with a shell at hand — and hand-made expected values sent it
// chasing differences that were its own slips. The rule is in the system prompt (CALC_PROMPT,
// local.ts); this makes it hold: a reply of the work whose text counts LINES lines of "a op b = c"
// is cut and told to write the calculation as a program, at most MAX_STEERS times per task.
// Not in the plan step: its tools cannot run anything (its own calculator, NERD_PLAN_CALC=1, is
// plan-calc.ts, with its own stimuli). The mechanics are the repeat guard's
// (repeat-guard.ts): ctx.abort(), then the steer — headless run.ts takes it with takeSteer(),
// in the TUI it is sent once the cut reply has ended. NERD_CALC=1 turns it on (with the rule).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NUM = String.raw`\d[\d_,]*(?:\.\d+)?`;
/** One hand calculation: numbers joined by operators, then "= <number>". */
export const ARITH = new RegExp(String.raw`${NUM}\s*[*×x·/+−-]\s*\(?${NUM}\)?(?:\s*[*×x·/+−-]\s*\(?${NUM}\)?)*\s*=\s*-?${NUM}`);
export const LINES = 10;
export const MAX_STEERS = 2;
const EVERY = 200;
const WRITE_TOOLS = ["write", "edit", "bash"];
export const CUT_PREFIX = "[harness] Your reply was cut";

/** The lines of `text` that are a hand calculation. */
export function arithLines(text: string): string[] {
	return text.split("\n").filter((l) => ARITH.test(l));
}

export function calcSteer(retry: number, sample: string): string {
	const s = sample.trim().replace(/\s+/g, " ").slice(0, 160);
	const head = `${CUT_PREFIX}: you were computing by hand ("${s}").`;
	const how =
		" Write the calculation as a program and run it — `python3 -c '…'`, `node -e '…'`, or `nerd-rs-eval '…'` in Rust — and work from what it prints: every number, the expected values of your checks too (from the task's text, not from your code).";
	return retry < MAX_STEERS ? `${head}${how}` : `${head} This is the second time.${how}`;
}

type Msg = { role?: string; content?: unknown };

function replyText(m: Msg | undefined): string {
	if (!m || !Array.isArray(m.content)) return typeof m?.content === "string" ? m.content : "";
	return m.content.map((c: { type?: string; text?: string; thinking?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "thinking" ? (c.thinking ?? "") : "")).join("\n");
}

export function calcGuard(pi: ExtensionAPI, opts: { operator: boolean; lines?: number }) {
	const max = opts.lines ?? LINES;
	let checkedAt = 0;
	let steers = 0;
	let cut = false;
	let pending: string | undefined;

	pi.on("before_agent_start", (event) => {
		// A message of the operator's (not a harness steer) starts a fresh budget.
		if (!event.prompt.startsWith(CUT_PREFIX) && !event.prompt.startsWith("[harness] The work's time is up")) steers = 0;
		return undefined;
	});
	pi.on("message_start", () => {
		checkedAt = 0;
		cut = false;
	});
	pi.on("message_update", (event, ctx) => {
		if (cut || steers >= MAX_STEERS) return;
		if (!pi.getActiveTools().some((t) => WRITE_TOOLS.includes(t))) return; // the plan step, or no tools
		const text = replyText(event.message as Msg);
		if (text.length - checkedAt < EVERY) return;
		checkedAt = text.length;
		const lines = arithLines(text);
		if (lines.length < max) return;
		cut = true;
		steers += 1;
		pending = calcSteer(steers, lines[lines.length - 1]);
		pi.appendEntry("nerd-calc-guard", { lines: lines.length, chars: text.length, steer: steers });
		ctx.abort();
	});
	pi.on("message_end", () => {
		if (!cut || !opts.operator || !pending) return;
		const s = pending;
		pending = undefined;
		pi.sendUserMessage(s, { deliverAs: "steer" });
	});
	return {
		/** Headless: the steer to send as the next prompt, once. */
		takeSteer(): string | undefined {
			const s = pending;
			pending = undefined;
			return s;
		},
	};
}
