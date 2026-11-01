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
//
// The hard step (process ticket 109): on the bench of process ticket 106 a
// headless run made one call 718 times in a row, over an hour, to its time limit,
// with the note on every third result; the code was right all along, and the run
// never said done. So when a call has had NERD_LOOP_GUARD_HARD notes (default 2;
// 0: notes only) and is made again, the reply is cut (Pi's abort) and the next
// message says what the loop was — at most twice per task; a third time the turn
// just ends: headless, the Ralph loop then checks the work and starts a new
// round, compacted, if it is not done; in the TUI the operator has the word.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_LOOP_N = 3;
export const DEFAULT_LOOP_HARD = 2;
/** Cuts with a message after them, per task; the next one only ends the turn. */
export const MAX_LOOP_STEERS = 2;
const STEER_HEAD = "[harness] Your reply was cut by the loop guard";

function count(raw: string | undefined, dflt: number): number {
	if (raw === undefined || raw.trim() === "") return dflt;
	const v = Number(raw);
	return Number.isInteger(v) && v >= 0 ? v : dflt;
}

export function loopGuardN(env = process.env): number {
	return count(env.NERD_LOOP_GUARD_N, DEFAULT_LOOP_N);
}

export function loopGuardHard(env = process.env): number {
	return count(env.NERD_LOOP_GUARD_HARD, DEFAULT_LOOP_HARD);
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

export function loopSteer(steer: number, tool: string, args: unknown, times: number): string {
	const call = `${tool} ${stable(args)}`.slice(0, 300);
	return (
		`${STEER_HEAD}: you made this exact call ${times} times with the same result, and the notes about it did not stop you:\n${call}\n` +
		"Do not run it again. In one or two sentences say what you were waiting to see, then either do the next step of the work another way " +
		`or, if the work is done, say it is done and stop.${steer > 1 ? " This is the second time; the next time the turn ends here." : ""}`
	);
}

export class LoopGuard {
	private recent: string[] = [];
	private totals = new Map<string, number>();
	private notes = new Map<string, number>();
	readonly n: number;
	readonly hard: number;
	/** Set by record(): the last call is a loop past its notes (the hard step). */
	stuck?: { tool: string; args: unknown; times: number };
	constructor(n = DEFAULT_LOOP_N, hard = 0) {
		this.n = n;
		this.hard = hard;
	}

	/** Records a finished call; returns the note to append when it is a repeat. */
	record(tool: string, args: unknown, result: string): string | undefined {
		this.stuck = undefined;
		if (this.n <= 0) return undefined;
		const sig = `${tool}\u0000${stable(args)}\u0000${result}`;
		this.recent.push(sig);
		if (this.recent.length > 2 * this.n + 2) this.recent.shift();
		const times = (this.totals.get(sig) ?? 0) + 1;
		this.totals.set(sig, times);
		const noted = this.notes.get(sig) ?? 0;
		// Past its notes, the next repeat is enough: the model has been told N·hard times.
		if (this.hard > 0 && noted >= this.hard) {
			this.stuck = { tool, args, times };
			return undefined;
		}
		const inWindow = this.recent.filter((s) => s === sig).length;
		if (inWindow < this.n) return undefined;
		this.recent = this.recent.filter((s) => s !== sig);
		this.notes.set(sig, noted + 1);
		return loopNote(times);
	}

	/** After a cut: the loop's count starts again (a new task, or the model's own new way). */
	reset() {
		this.notes.clear();
		this.recent = [];
		this.stuck = undefined;
	}
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

/**
 * The guard as a Pi extension: one per session, on every tool result. `operator`: a
 * person drives the session (TUI), so the extension sends the hard step's message
 * itself; headless, run.ts takes it with takeSteer(). `hard` 0: notes only (the scout).
 */
export function loopGuard(pi: ExtensionAPI, opts: { operator?: boolean; n?: number; hard?: number } = {}) {
	const n = opts.n ?? loopGuardN();
	const hard = opts.hard ?? 0;
	let guard = new LoopGuard(n, hard);
	let steers = 0;
	let pending: string | undefined;
	pi.on("session_start", () => {
		guard = new LoopGuard(n, hard);
	});
	pi.on("before_agent_start", (event) => {
		// A new message of the operator's (not our own) starts a fresh budget.
		if (!event.prompt.startsWith(STEER_HEAD)) steers = 0;
		return undefined;
	});
	pi.on("tool_result", (event, ctx) => {
		const note = guard.record(event.toolName, event.input, textOf(event.content));
		const stuck = guard.stuck;
		if (stuck) {
			guard.reset();
			steers += 1;
			pi.appendEntry("nerd-loop-guard", { tool: stuck.tool, times: stuck.times, steer: steers <= MAX_LOOP_STEERS ? steers : 0 });
			if (steers <= MAX_LOOP_STEERS) pending = loopSteer(steers, stuck.tool, stuck.args, stuck.times);
			ctx.abort();
			return;
		}
		if (!note) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${note}` }],
			structuredContent: event.structuredContent,
		};
	});
	pi.on("agent_end", () => {
		if (!opts.operator || !pending) return;
		const s = pending;
		pending = undefined;
		pi.sendUserMessage(s, { deliverAs: "steer" });
	});
	return {
		/** Headless: the message to send as the next prompt, once. */
		takeSteer(): string | undefined {
			const s = pending;
			pending = undefined;
			return s;
		},
	};
}
