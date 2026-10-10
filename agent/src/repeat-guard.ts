// The repeat guard (ticket 071 of the process, layer 3). A reply can fall into a
// loop: the same piece of text again and again, for tens of thousands of
// characters, until the token cap. The guard watches the streamed reply and, when
// its tail is three or more copies of one piece of 30-3000 characters (300 at
// least in all), stops the generation and tells the model what it repeated —
// at most twice per task, then it lets the reply be. Our own rule, after the
// "tail periodicity" of @capdiem/pi-repetition-guard (MIT) and the content loop
// check of Gemini CLI; three copies, not two, so that a block written twice is no
// loop. Re-drafting with different words is not caught here: the plan step has
// its own length cap for that (plan-step.ts).
//
// Pi ends its whole run on ctx.abort(), so the next message is sent from outside:
// in the TUI by the extension once the cut reply has ended; headless, run.ts asks
// takeSteer() after each prompt and sends it as the next prompt.
// NERD_REPEAT_GUARD=0 turns it off.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_PERIOD = 30;
const MAX_PERIOD = 3000;
const MIN_COPIES = 3;
const MIN_TOTAL = 300;
/** How often the streamed text is looked at, in new characters. */
const EVERY = 200;
export const MAX_STEERS = 2;

export interface Loop {
	period: number;
	copies: number;
	sample: string;
}

/** The loop at the end of `text`, or undefined: its shortest repeating unit with at least three copies. */
export function tailLoop(text: string): Loop | undefined {
	const n = text.length;
	for (let p = MIN_PERIOD; p <= MAX_PERIOD && MIN_COPIES * p <= n; p++) {
		const unit = text.slice(n - p);
		let copies = 1;
		while ((copies + 1) * p <= n && text.slice(n - (copies + 1) * p, n - copies * p) === unit) copies++;
		if (copies >= MIN_COPIES && copies * p >= MIN_TOTAL) return { period: p, copies, sample: unit };
	}
	return undefined;
}

export function repeatSteer(retry: number, sample: string): string {
	const s = sample.trim().replace(/\s+/g, " ").slice(0, 200);
	const head = `[harness] Your reply was cut: it repeated the same text over and over ("${s}${sample.trim().length > 200 ? "…" : ""}").`;
	return retry < MAX_STEERS
		? `${head} Do not write it again. Take the next step instead: if you were about to act, act now with a tool; if you were writing a plan or an answer, give it once, short.`
		: `${head} This is the second time. Either take a different next step than the one you kept repeating, or say plainly what blocks you and what you cannot do.`;
}

export function repeatGuardOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_REPEAT_GUARD !== "0";
}

type Msg = { role?: string; content?: unknown };

function replyText(m: Msg | undefined): string {
	if (!m || !Array.isArray(m.content)) return typeof m?.content === "string" ? m.content : "";
	return m.content.map((c: { type?: string; text?: string; thinking?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "thinking" ? (c.thinking ?? "") : "")).join("\n");
}

/**
 * The guard as a Pi extension. `operator`: a person drives the session (TUI), so
 * the extension sends the steer itself; headless, run.ts takes it with takeSteer().
 */
export function repeatGuard(pi: ExtensionAPI, opts: { operator: boolean }) {
	let checkedAt = 0;
	let steers = 0;
	let cut: Loop | undefined;
	let pending: string | undefined;

	pi.on("before_agent_start", (event) => {
		// A new message of the operator's (not our own steer) starts a fresh budget.
		if (!event.prompt.startsWith("[harness] Your reply was cut")) steers = 0;
		return undefined;
	});
	pi.on("message_start", () => {
		checkedAt = 0;
		cut = undefined;
	});
	pi.on("message_update", (event, ctx) => {
		if (cut || steers >= MAX_STEERS) return;
		const text = replyText(event.message as Msg);
		if (text.length - checkedAt < EVERY) return;
		checkedAt = text.length;
		const loop = tailLoop(text);
		if (!loop) return;
		cut = loop;
		steers += 1;
		pending = repeatSteer(steers, loop.sample);
		pi.appendEntry("nerd-repeat-guard", { period: loop.period, copies: loop.copies, chars: text.length, steer: steers });
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
