// Long bash output: head, tail and a file (ticket 057 of the process). Pi
// keeps the last 2000 lines or 50 KB of a command's output, ~17K tokens at the
// model's ~2.9 characters per token: a quarter of a 64K window for one call.
// In the first acceptance run on main (2026-10-07, the operator's laptop) one call printed 57940
// lines of WebSocket messages and another 17972 lines of "Done"; each went into
// the context whole, and the next compaction came sooner.
//
// Here a bash result longer than NERD_BASH_MAX_CHARS (8000) is cut to its first
// and last lines with a marker between them naming how much was left out and
// the file that holds all of it (Pi's own file when Pi cut the output, else one
// of ours under $TMPDIR/nerd-bash/). Most of the budget goes to the tail: that is
// where a test runner's summary, a build's error and a stack trace end up. Runs
// of identical lines are collapsed first ("Done" [x17972]), which alone often
// brings an output under the limit. An error in the middle is not lost: the
// first lines there that read like failures (error, FAIL, not ok, Traceback ...)
// are shown between head and tail with their line numbers in the file. Pi's exit
// line ("Command exited with code 1") stays as it was. NERD_BASH_MAX_CHARS=0
// turns it off.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_CHARS = 8000;
/** Share of the budget for the head; the rest is the tail. */
const HEAD_SHARE = 0.3;

export function outputMax(env = process.env): number {
	const v = env.NERD_BASH_MAX_CHARS;
	if (v === undefined || v === "") return DEFAULT_MAX_CHARS;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CHARS;
}

/** Pi's note when it cut the output: `[Showing lines a-b of n (50.0KB limit). Full output: <path>]`. */
const PI_NOTE = /\n*\[Showing lines \d+-\d+ of \d+[^\]]*?\. Full output: (\S+)\]/;
/** Pi's line after the output of a failed command. */
const EXIT_LINE = /\n*(Command exited with code \d+)\s*$/;

/** Three or more identical consecutive lines become one, with a count; each with its line number (1-based). */
function collapse(lines: string[]): { text: string; no: number }[] {
	const out: { text: string; no: number }[] = [];
	for (let i = 0; i < lines.length; ) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const n = j - i;
		if (n >= 3) out.push({ text: `${lines[i]}  [x${n} identical lines]`, no: i + 1 });
		else for (let k = i; k < j; k++) out.push({ text: lines[k], no: k + 1 });
		i = j;
	}
	return out;
}

export function collapseRuns(lines: string[]): string[] {
	return collapse(lines).map((l) => l.text);
}

/** A line that reads like a failure: what the left-out middle must not hide. */
const LOOKS_LIKE_ERROR = /\b(error|errors|fail|failed|failure|fatal|exception|traceback|panic|assert\w*|cannot|not ok|undefined|denied|refused)\b|✖|✗/i;
/** At most this many such lines from the middle, and this share of the budget. */
const MIDDLE_LINES = 10;
const MIDDLE_SHARE = 0.15;

/** Whole lines from the front (or the back) within `budget` characters; an over-long single line is cut. */
function take(lines: string[], budget: number, fromEnd: boolean): string[] {
	const out: string[] = [];
	let used = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[fromEnd ? lines.length - 1 - i : i];
		if (used + line.length + 1 > budget) {
			if (out.length === 0) {
				const keep = Math.max(0, budget - 1);
				out.push(fromEnd ? `…${line.slice(line.length - keep)}` : `${line.slice(0, keep)}…`);
			}
			break;
		}
		out.push(line);
		used += line.length + 1;
	}
	return fromEnd ? out.reverse() : out;
}

/**
 * The output as the model should see it, or undefined when it is short enough
 * to leave alone. `full` is the whole output, `path` the file that holds it.
 */
export function headTail(full: string, max: number, path: string): string {
	const all = full.split("\n");
	const rows = collapse(all);
	const lines = rows.map((r) => r.text);
	const collapsed = lines.join("\n");
	const where = `The whole output (${all.length} lines, ${(full.length / 1024).toFixed(1)} KB) is in ${path}: search it with grep, or read parts with sed -n / tail.`;
	if (collapsed.length <= max) return `${collapsed}\n[harness] Identical lines collapsed. ${where}`;
	const head = take(lines, Math.floor(max * HEAD_SHARE), false);
	// Lines in what the tail will not reach that read like failures: the first
	// few, numbered as in the file. Their budget comes out of the tail's.
	const rest = rows.slice(head.length);
	const tailGuess = take(lines.slice(head.length), max - head.join("\n").length, true).length;
	const middle: string[] = [];
	let used = 0;
	for (const r of rest.slice(0, rest.length - tailGuess)) {
		if (middle.length >= MIDDLE_LINES || !LOOKS_LIKE_ERROR.test(r.text)) continue;
		const line = `${r.no}: ${r.text.length > 300 ? `${r.text.slice(0, 299)}…` : r.text}`;
		if (used + line.length + 1 > max * MIDDLE_SHARE) break;
		middle.push(line);
		used += line.length + 1;
	}
	const tail = take(lines.slice(head.length), max - head.join("\n").length - used, true);
	const omitted = lines.length - head.length - tail.length;
	const found = middle.length ? `\n[harness] Lines there that look like errors (line: text):\n${middle.join("\n")}` : "";
	return `${head.join("\n")}\n[harness] … ${omitted} lines left out here. ${where}${found}\n[harness] The last lines:\n${tail.join("\n")}`;
}

/**
 * Write `text` to a file of ours; its path. Named by the content's hash, so the
 * same output gives the same text and the loop guard still sees a repeat.
 */
function keep(text: string): string {
	const dir = join(process.env.TMPDIR || tmpdir(), "nerd-bash");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, `${createHash("sha1").update(text).digest("hex").slice(0, 12)}.log`);
	writeFileSync(p, text);
	return p;
}

/**
 * A bash result's text → the text to give the model, or undefined to leave it.
 * Exported for the tests; `readFile` and `keepFile` are the file system.
 */
export function capBashText(
	text: string,
	max: number,
	readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
	keepFile: (t: string) => string = keep,
): string | undefined {
	if (max <= 0) return undefined;
	let body = text;
	let trailer = "";
	const exit = EXIT_LINE.exec(body);
	if (exit) {
		trailer = exit[1];
		body = body.slice(0, exit.index);
	}
	let path: string | undefined;
	const note = PI_NOTE.exec(body);
	if (note) {
		// Pi cut it: its file has the whole output, head included.
		try {
			body = readFile(note[1]).replace(/\n$/, "");
			path = note[1];
		} catch {
			body = body.slice(0, note.index) + body.slice(note.index + note[0].length);
		}
	}
	if (!note && body.length <= max) return undefined;
	if (note && !path && body.length <= max) return undefined;
	path ??= keepFile(body);
	const out = headTail(body, max, path);
	return trailer ? `${out}\n\n${trailer}` : out;
}

/** As a Pi extension: on every bash result, success or failure. */
export function outputCap(pi: ExtensionAPI, env = process.env) {
	const max = outputMax(env);
	if (max <= 0) return;
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const texts = event.content.filter((c) => c.type === "text");
		if (texts.length === 0) return;
		const text = texts.map((c) => (c as { text: string }).text).join("\n");
		const capped = capBashText(text, max);
		if (capped === undefined) return;
		return {
			content: [...event.content.filter((c) => c.type !== "text"), { type: "text" as const, text: capped }],
			details: event.details,
		};
	});
}
