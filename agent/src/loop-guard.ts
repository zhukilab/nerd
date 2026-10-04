// Loop guard (ticket 043): the same tool call, with the same arguments and the
// same result, made again and again. In a TUI run of 2026-10-03 the model ran
// `grep -c "19" index.html` 582 times in a row for 20 minutes (always "0"), and
// two context compactions did not break the loop. The guard does not stop the
// run: it appends a note to the repeated call's result, which is the first
// thing the model reads before its next step.
//
// A call counts as a repeat when the same tool, arguments and result occur
// NERD_LOOP_GUARD_N times (default 3; 0 turns the guard off) among the last
// 2N + 2 calls, so one different call in between (`grep -n` among the
// `grep -c`) does not hide the loop. A changed result is a new call: polling a
// server until it answers is not a loop. After a note, that call's count
// starts again, so a loop that goes on gets a note every N repeats.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_LOOP_N = 3;

export function loopGuardN(env = process.env): number {
	const raw = env.NERD_LOOP_GUARD_N;
	if (raw === undefined || raw.trim() === "") return DEFAULT_LOOP_N;
	const v = Number(raw);
	return Number.isInteger(v) && v >= 0 ? v : DEFAULT_LOOP_N;
}

/** JSON with sorted keys, so argument order does not make two calls different. */
function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v) ?? "undefined";
}

export function loopNote(times: number): string {
	return (
		`[loop guard] You have now made this exact call ${times} times with the same result. ` +
		"Running it again will not tell you anything new. Stop, say in one sentence what you are trying to find out, " +
		"and get at it a different way; if you are stuck, say so."
	);
}

export class LoopGuard {
	private recent: string[] = [];
	private totals = new Map<string, number>();
	readonly n: number;
	constructor(n = DEFAULT_LOOP_N) {
		this.n = n;
	}

	/** Records a finished call; returns the note to append when it is a repeat. */
	record(tool: string, args: unknown, result: string): string | undefined {
		if (this.n <= 0) return undefined;
		const sig = `${tool}\u0000${stable(args)}\u0000${result}`;
		this.recent.push(sig);
		if (this.recent.length > 2 * this.n + 2) this.recent.shift();
		this.totals.set(sig, (this.totals.get(sig) ?? 0) + 1);
		const inWindow = this.recent.filter((s) => s === sig).length;
		if (inWindow < this.n) return undefined;
		this.recent = this.recent.filter((s) => s !== sig);
		return loopNote(this.totals.get(sig)!);
	}
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

/** The guard as a Pi extension: one per session, on every tool result. */
export function loopGuard(pi: ExtensionAPI, n = loopGuardN()) {
	let guard = new LoopGuard(n);
	pi.on("session_start", () => {
		guard = new LoopGuard(n);
	});
	pi.on("tool_result", (event) => {
		const note = guard.record(event.toolName, event.input, textOf(event.content));
		if (!note) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${note}` }],
			structuredContent: event.structuredContent,
		};
	});
}
