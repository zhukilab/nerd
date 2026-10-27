// The model's thinking of earlier steps left out of the request (process ticket 057).
// Pi sends every reply's thinking back to the server (reasoning_content), and the chat
// template keeps it within a turn — and the work on a plan is one turn. At a compaction
// 77% (median) of the live context was old thinking in runs with thinking on (210
// compactions, 61 runs); so the window filled with reasoning about steps already done.
//
// NERD_THINKING_KEEP=N: in each request only the last N replies that have thinking keep
// it; older replies keep their text and tool calls. Nothing in the session file changes
// (the thinking stays there and in the event log), and the prefix cache loses only the
// tail from the reply whose thinking was dropped last.
//
// On by default with N=0 (process ticket 057, 2026-10-23): 12 Bonsai runs of the 015 tasks
// against 12 with all thinking — PASS 11/12 against 7/12, compactions in the work 0.1 per run
// against 1.6, no sign of a lost thread. NERD_THINKING_KEEP=all sends all of it back, as Pi does.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_THINKING_KEEP = 0;

/** N, or undefined for "all" (the mechanism off); unset or not a whole number: the default. */
export function thinkingKeep(env = process.env): number | undefined {
	const v = env.NERD_THINKING_KEEP;
	if (v === "all") return undefined;
	return v !== undefined && /^\d+$/.test(v) ? Number(v) : DEFAULT_THINKING_KEEP;
}

type Block = { type?: string };
type Msg = { role?: string; content?: unknown };

const hasThinking = (m: Msg) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "thinking");

/** `messages` with the thinking of all but the last `keep` replies that have it taken out; the same array when there is nothing to take. */
export function dropOldThinking<T>(messages: T[], keep: number): T[] {
	const withThinking = (messages as Msg[]).flatMap((m, i) => (hasThinking(m) ? [i] : []));
	const drop = new Set(withThinking.slice(0, Math.max(0, withThinking.length - keep)));
	if (drop.size === 0) return messages;
	return messages.map((m, i) =>
		drop.has(i) ? ({ ...m, content: ((m as Msg).content as Block[]).filter((b) => b.type !== "thinking") } as T) : m,
	);
}

/** As a Pi extension: old thinking out of each request's context. */
export function thinkingKeepExtension(pi: ExtensionAPI, keep: number) {
	pi.on("context", (event) => {
		const messages = dropOldThinking(event.messages, keep);
		return messages === event.messages ? undefined : { messages };
	});
}
