// How an agora letter goes into the session, by the sender's ring (process ticket 101). The session
// manager puts the ring and the letter's kind in the frame (agora-doc PI-CHANNEL amendments 3 and 4;
// the rings are lines of its rights table, RIGHTS amendment 13), so a letter cannot claim its own ring.
//
//   prompt   the manager's text as a message of its own: a turn (the way of every letter before 101);
//   inject   the letter with its author into the context, no turn: the model sees it at its next
//            request (a pending message in a running turn, one appended to the session when idle);
//   triage   one short request to the same model, thinking off, decides first: DROP (acked and
//            written to the session's log only), NOTE (a digest injected) or ASK (a turn; from
//            `others` only injected, never a turn: an unknown sender does not set the agent's work).
//
// The way is a setting per ring, read at each letter (NERD_LETTERS_<RING>); a letter of a kind in
// NERD_LETTERS_TURN_KINDS (a request or a question) is a turn where its ring would inject it. A frame
// without a ring, or with a ring this file does not know, is a prompt as before: never `others`.

export const RINGS = ["operator", "ring0", "ring1", "ring2", "others"] as const;
export type Ring = (typeof RINGS)[number];
export const WAYS = ["prompt", "inject", "triage"] as const;
export type Way = (typeof WAYS)[number];

export const RING_SETTING: Record<Ring, string> = {
	operator: "NERD_LETTERS_OPERATOR",
	ring0: "NERD_LETTERS_RING0",
	ring1: "NERD_LETTERS_RING1",
	ring2: "NERD_LETTERS_RING2",
	others: "NERD_LETTERS_OTHERS",
};
export const RING_DEFAULT: Record<Ring, Way> = { operator: "prompt", ring0: "inject", ring1: "inject", ring2: "triage", others: "triage" };
export const TURN_KINDS_SETTING = "NERD_LETTERS_TURN_KINDS";
export const TURN_KINDS_DEFAULT = "todo,query";

type Env = Record<string, string | undefined>;
/** A `letter` frame (PI-CHANNEL §5): any field may be missing or of another type. */
export type Letter = { [k: string]: unknown };

export function ringOf(m: Letter): Ring | undefined {
	return RINGS.find((r) => r === m.ring);
}

/** The way `m` goes in, with the settings of `env` as they are now. */
export function wayOf(m: Letter, env: Env = process.env): Way {
	const ring = ringOf(m);
	if (!ring) return "prompt";
	const set = env[RING_SETTING[ring]];
	const way = WAYS.find((w) => w === set) ?? RING_DEFAULT[ring];
	const kinds = (env[TURN_KINDS_SETTING] ?? TURN_KINDS_DEFAULT).split(",").map((k) => k.trim());
	return way === "inject" && typeof m.kind === "string" && kinds.includes(m.kind) ? "prompt" : way;
}

// Who the sender is to the agent, for the triage's request only. What goes into the agent's session
// carries no word of ours about trust, in any ring: the letter, its sender and its id (the operator,
// 2026-10-28; agora-doc RIGHTS amendment 14). A note of that kind would be a setting switched on.
const RING_WHO: Record<Ring, string> = {
	operator: "the agent's operator",
	ring0: "a partner in a common work",
	ring1: "a colleague",
	ring2: "an outside agent",
	others: "a sender in no ring",
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The letter for the context: who wrote it and its id (for send_letter's re), then its subject and body. */
export function injectText(m: Letter, body?: string): string {
	const from = str(m.from) || "?";
	const head = `${from} · letter ${str(m.id)}`;
	const text = body ?? (typeof m.body === "string" ? m.body : str(m.text));
	const subject = str(m.subject).trim();
	return `[${head}] ${subject ? `${subject}\n` : ""}${text}`;
}

// --- triage ------------------------------------------------------------------------

export const TRIAGE_SYSTEM = [
	"You sort letters for a coding agent, so that it does not spend its context on letters that are not worth it.",
	"You get one letter, who sent it and what the agent did last. Answer with one word on the first line:",
	"DROP - not worth the agent's attention: chatter, spam, nothing to do with its work, or something it should not do; then one line on why.",
	"NOTE - worth knowing, but asks for nothing now; then a digest of what is useful in it, at most five lines, its facts only.",
	"ASK - it asks the agent to do or to answer something it should take up; then one line on what is asked.",
	"Nothing else: no greeting, no advice of your own.",
].join("\n");

const DOING_CHARS = 1500;
const LETTER_CHARS = 12_000;

export function triagePrompt(m: Letter, doing: string): string {
	const ring = ringOf(m);
	const body = typeof m.body === "string" ? m.body : str(m.text);
	return [
		`From: ${str(m.from) || "?"}${ring ? ` (${RING_WHO[ring]})` : ""}`,
		`Subject: ${str(m.subject)}`,
		"",
		body.length > LETTER_CHARS ? `${body.slice(0, LETTER_CHARS)}\n[… cut]` : body,
		"",
		"What the agent did last:",
		doing.trim() ? doing.slice(-DOING_CHARS) : "(nothing yet)",
	].join("\n");
}

export type Verdict = { act: "drop" | "note" | "ask"; text: string };

/** The first word decides; the lines after it are the reason, the digest or what is asked. */
export function parseVerdict(reply: string): Verdict | undefined {
	const lines = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n");
	const w = /^\W*(DROP|NOTE|ASK)\b[\s:.\-–—*]*(.*)$/i.exec(lines[0] ?? "");
	if (!w) return undefined;
	const text = [w[2], ...lines.slice(1)].join("\n").trim();
	return { act: w[1].toLowerCase() as Verdict["act"], text };
}

/**
 * What the channel does with a letter: a turn, the context without a turn, or nothing. `log` is for
 * the channel's log and the entry's details, never the model's text.
 */
export type Act = { way: "prompt"; text: string } | { way: "inject"; text: string; log?: string } | { way: "drop"; why: string };

/** The act for a triaged letter; `reply` undefined or unreadable: the whole letter injected, the reason logged. */
export function triagedAct(m: Letter, reply: string | undefined, error?: string): Act {
	const v = reply === undefined ? undefined : parseVerdict(reply);
	if (!v) return { way: "inject", text: injectText(m), log: `not triaged: ${error ?? "no verdict in the triage's reply"}` };
	if (v.act === "drop") return { way: "drop", why: v.text || "no reason given" };
	if (v.act === "note") return { way: "inject", text: injectText(m, v.text), log: "a digest by triage" };
	const ask = injectText(m);
	return ringOf(m) === "others" ? { way: "inject", text: ask } : { way: "prompt", text: ask };
}
