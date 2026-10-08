// Lint after every edit (process ticket 051). In the first acceptance run
// (036) the agent shipped a page whose script did not parse
// (`let ws.closedByUs = false;`), a module with a missing import, and reported
// "verified and working": it checked the server with curl, never the file it
// had just written. Here every successful write or edit of a file a linter
// knows is linted at once, and what the linter reports as an error is appended
// to that tool's result, the first thing the model reads next. The model does
// not decide whether to run it. Nothing is added when the file is clean: no
// prompt tokens, no noise.
//
// Errors only, never style: a small model chases style remarks for hours.
//   .js .mjs .cjs .jsx .ts .tsx .mts .cts .json .jsonc .css
//             biome lint, our config (src/lint/biome.json): parse errors and
//             undeclared names (browser and Node globals are known to biome)
//   .html .htm  each inline <script> without src, the same way
//   .py       ruff: syntax errors and undefined names (E9, F63, F7, F82x)
//   .sh .bash, or a #!...sh first line  shellcheck -S error
// A linter missing from PATH is skipped (the image has all three).
// NERD_LINT=0 turns it off.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BIOME_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "lint");
const MAX_LINES = 15;
const TIMEOUT_MS = 20_000;
const BIOME_EXT = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css"];

export function lintOn(env = process.env): boolean {
	return env.NERD_LINT !== "0";
}

/** One problem: the line in the file and the linter's message. */
export type Problem = { line: number; text: string };

/** biome's github reporter: `::error title=<rule>,file=...,line=N,...::<message>`. */
export function parseBiome(out: string): Problem[] {
	const ps: Problem[] = [];
	for (const m of out.matchAll(/^::error title=([^,]*),[^\n]*?\bline=(\d+)[^\n]*?::(.*)$/gm)) {
		const rule = m[1] === "parse" ? "" : ` (${m[1].replace(/^lint\//, "")})`;
		ps.push({ line: Number(m[2]), text: `${m[3].trim()}${rule}` });
	}
	return ps;
}

/** ruff's concise output: `<file>:<line>:<col>: <code> <message>`. */
export function parseRuff(out: string): Problem[] {
	return [...out.matchAll(/^[^\n:]+:(\d+):\d+: (.+)$/gm)].map((m) => ({ line: Number(m[1]), text: m[2].trim() }));
}

/** shellcheck -f gcc: `<file>:<line>:<col>: error: <message> [SCnnnn]`. */
export function parseShellcheck(out: string): Problem[] {
	return [...out.matchAll(/^[^\n:]+:(\d+):\d+: \w+: (.+)$/gm)].map((m) => ({ line: Number(m[1]), text: m[2].trim() }));
}

function have(cmd: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

function run(cmd: string, args: string[]): string | undefined {
	if (!have(cmd)) return undefined;
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: TIMEOUT_MS });
	return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

function biome(file: string): Problem[] {
	const out = run("biome", ["lint", `--config-path=${BIOME_CONFIG}`, "--diagnostic-level=error", "--reporter=github", "--colors=off", "--no-errors-on-unmatched", file]);
	return out === undefined ? [] : parseBiome(out);
}

/** Inline scripts of an HTML page: [code, isModule, line of the <script> tag]. */
export function inlineScripts(html: string): [string, boolean, number][] {
	const out: [string, boolean, number][] = [];
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		const attrs = m[1];
		if (/\bsrc\s*=/i.test(attrs)) continue;
		const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
		if (type && type !== "module" && !type.includes("javascript")) continue; // JSON, templates
		if (!m[2].trim()) continue;
		out.push([m[2], type === "module", html.slice(0, m.index).split("\n").length]);
	}
	return out;
}

function lintHtml(text: string): Problem[] {
	const scripts = inlineScripts(text);
	if (!scripts.length || !have("biome")) return [];
	const dir = mkdtempSync(join(tmpdir(), "nerd-lint-"));
	try {
		const ps: Problem[] = [];
		scripts.forEach(([code, isModule, line], i) => {
			const f = join(dir, `inline-${i}${isModule ? ".mjs" : ".js"}`);
			writeFileSync(f, code);
			// The script's text starts on the <script> tag's line.
			for (const p of biome(f)) ps.push({ line: line + p.line - 1, text: `<script>: ${p.text}` });
		});
		return ps;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function isShell(path: string, text: string): boolean {
	return [".sh", ".bash"].includes(extname(path).toLowerCase()) || /^#!.*\b(ba|da|k)?sh\b/.test(text.split("\n", 1)[0]);
}

/** What the linter reports as errors in a file as written; [] when clean or not ours to lint. */
export function lintFile(path: string): Problem[] {
	const ext = extname(path).toLowerCase();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	if (BIOME_EXT.includes(ext)) return biome(path);
	if (ext === ".html" || ext === ".htm") return lintHtml(text);
	if (ext === ".py") {
		const out = run("ruff", ["check", "--isolated", "--no-cache", "--select", "E9,F63,F7,F821,F822,F823", "--output-format", "concise", path]);
		return out === undefined ? [] : parseRuff(out);
	}
	if (isShell(path, text)) {
		const out = run("shellcheck", ["-S", "error", "-f", "gcc", path]);
		return out === undefined ? [] : parseShellcheck(out);
	}
	return [];
}

export function lintNote(path: string, ps: Problem[]): string {
	const lines = ps.slice(0, MAX_LINES).map((p) => `  line ${p.line}: ${p.text}`);
	if (ps.length > MAX_LINES) lines.push(`  ... ${ps.length - MAX_LINES} more`);
	return `[lint] ${path}: ${ps.length} error${ps.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nFix these before running or reporting anything that depends on this file.`;
}

/** The check as a Pi extension: after every successful write or edit. */
export function lintCheck(pi: ExtensionAPI) {
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const raw = (event.input as { path?: unknown })?.path;
		if (typeof raw !== "string" || !raw) return;
		const ps = lintFile(resolve(ctx.cwd || process.cwd(), raw));
		if (!ps.length) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${lintNote(raw, ps)}` }],
			structuredContent: event.structuredContent,
		};
	});
}
