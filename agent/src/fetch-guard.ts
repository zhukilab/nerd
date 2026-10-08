// Fetch guard: a web_fetch of an address the model made up. In the A/B of
// ticket 048 (60 runs) web_fetch failed 151 times in 315; of the addresses
// taken from web_search results 6 in 66 failed, of the ones the model guessed
// (raw.githubusercontent.com paths, spec anchors, wiki titles) 145 in 249, and
// after such a 404 the next web call guessed again 90 times in 141. The guard
// does not block anything: it appends a note to the failed result, which the
// model reads before its next step, as the loop guard does.
//
// A note comes when web_fetch fails with 404 or 410 for an address that no
// web_search result of this session contained; and when www.npmjs.com refuses
// with 403 (the site turns robots away; the registry serves the same as JSON).
// NERD_FETCH_GUARD=0 turns it off.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function fetchGuardOn(env = process.env): boolean {
	return env.NERD_FETCH_GUARD !== "0";
}

/** An address as it is compared: no fragment, no trailing slash, host in lower case. */
export function normalUrl(raw: string): string {
	const s = raw.replace(/[)\]>"'.,;:]+$/, "");
	try {
		const u = new URL(s);
		u.hash = "";
		return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
	} catch {
		return s.replace(/#.*$/, "").replace(/\/+$/, "");
	}
}

export function urlsIn(text: string): string[] {
	return (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map(normalUrl);
}

export const MADE_UP_NOTE =
	"[fetch guard] This address was not in any web_search result: it was guessed, and it does not exist. " +
	"Do not guess another one. Run web_search for what you need and web_fetch an address from its results.";

export function npmNote(url: string): string {
	const name = new URL(url).pathname.replace(/^\/package\//, "").replace(/\/+$/, "");
	return (
		"[fetch guard] www.npmjs.com refuses robots. The same package data, README included, is JSON at " +
		`https://registry.npmjs.org/${name}`
	);
}

export class FetchGuard {
	private seen = new Set<string>();

	/** A web_search result: remember its addresses. */
	searched(text: string): void {
		for (const u of urlsIn(text)) this.seen.add(u);
	}

	/** A finished web_fetch: the note to append, if any. */
	fetched(url: string, isError: boolean, text: string): string | undefined {
		if (!isError || !url) return undefined;
		let host = "";
		try {
			host = new URL(url).host.toLowerCase();
		} catch {
			return undefined;
		}
		if (/\bHTTP 403\b/.test(text) && host === "www.npmjs.com" && url.includes("/package/")) return npmNote(url);
		if (/\bHTTP (404|410)\b/.test(text) && !this.seen.has(normalUrl(url))) {
			return MADE_UP_NOTE;
		}
		return undefined;
	}
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** The guard as a Pi extension: one per session, on web_search and web_fetch results. */
export function fetchGuard(pi: ExtensionAPI) {
	let guard = new FetchGuard();
	pi.on("session_start", () => {
		guard = new FetchGuard();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "web_search") {
			guard.searched(textOf(event.content));
			return;
		}
		if (event.toolName !== "web_fetch") return;
		const url = typeof event.input?.url === "string" ? event.input.url : "";
		const note = guard.fetched(url, event.isError, textOf(event.content));
		if (!note) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${note}` }],
			structuredContent: event.structuredContent,
		};
	});
}
