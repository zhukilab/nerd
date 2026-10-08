// Web notes: what web_fetch read is kept in the project, by the harness.
// The rule "write what you found in notes/<topic>.md with the URL" was in the
// web tools' guidance, which Pi drops when a system prompt of our own is set:
// it never reached the model, and in three acceptance runs notes/ was never
// written (prompt audit, ticket 059 of the process). The rules it had looked up
// were right in the code and wrong in the README, transcribed from memory.
//
// So after every successful web_fetch the harness writes the page to
// notes/web/<host-and-path>.md in the working directory: the URL, the time and
// the text (the whole page when web_fetch spilled it to a file; capped), and
// tells the model where it is. The anchors after a compaction list notes/.
// NERD_WEB_NOTES=0 turns it off.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WEB_NOTE_MAX = 20_000;

export function webNotesOn(env = process.env): boolean {
	return env.NERD_WEB_NOTES !== "0";
}

/** notes/web/<slug>.md: host and path, lower case, [a-z0-9-] only, ≤ 80 characters. */
export function webNoteName(url: string): string {
	let s = url;
	try {
		const u = new URL(url);
		s = `${u.host}${u.pathname}`;
	} catch {
		/* not a URL: use as is */
	}
	const slug = s
		.toLowerCase()
		.replace(/^www\./, "")
		.replace(/%[0-9a-f]{2}/g, "-")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/, "");
	return `${slug || "page"}.md`;
}

/** The note's text: the URL and time first, then the page, capped. */
export function webNoteText(url: string, page: string, when = new Date().toISOString(), max = WEB_NOTE_MAX): string {
	const body = page.length > max ? `${page.slice(0, max)}\n\n[cut at ${max} characters]` : page;
	return `# ${url}\n\nURL: ${url}\nFetched: ${when}\n\n${body.trim()}\n`;
}

/** Writes the note under cwd; returns its path relative to cwd. */
export function saveWebNote(cwd: string, url: string, page: string, when?: string): string {
	const dir = join(cwd, "notes", "web");
	mkdirSync(dir, { recursive: true });
	const name = webNoteName(url);
	writeFileSync(join(dir, name), webNoteText(url, page, when));
	return `notes/web/${name}`;
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** As a Pi extension: on each successful web_fetch result. */
export function webNotes(pi: ExtensionAPI) {
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "web_fetch" || event.isError) return;
		const url = typeof event.input?.url === "string" ? event.input.url : "";
		if (!url) return;
		const shown = textOf(event.content);
		// web_fetch cuts a long page and keeps the whole of it in a file.
		const full = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
		let page = shown;
		if (full && existsSync(full)) {
			try {
				page = readFileSync(full, "utf8");
			} catch {
				/* keep what was shown */
			}
		}
		let rel: string;
		try {
			rel = saveWebNote(ctx?.cwd ?? process.cwd(), url, page);
		} catch {
			return; // a read-only or missing directory: no note, the result stands
		}
		const note = `\n\n[harness] This page is saved in ${rel} (with its URL; commit it with your work). Where you use a fact from it, name the URL; rules you took from it belong in the README or on the page, as the source says them.`;
		return { content: [...event.content, { type: "text" as const, text: note }], structuredContent: event.structuredContent };
	});
}
