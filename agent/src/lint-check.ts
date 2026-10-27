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
//   .rs       cargo check of its crate, errors only (lintRust; after an edit only)
// A linter missing from PATH is skipped (the image has the first three; cargo comes with
// nerd-get rust).
// NERD_LINT=0 turns it off.

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cargoErrors, crateRoot } from "./cargo.ts";

const BIOME_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "lint");
const MAX_LINES = 15;
const TIMEOUT_MS = 20_000;
/** The name in biome noUndeclaredVariables, ruff F821. */
const UNDECLARED_NAME = /The (\S+) variable is undeclared|Undefined name `([^`]+)`/;
const HEAD_BYTES = 1 << 20;
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

const CARGO_CHECK_MS = 180_000;

/** rustc's short error line: `<file>:<line>:<col>: error[E0308]: <message>`. */
export function parseRustc(errors: string[], crate: string, file: string): Problem[] {
	const own: Problem[] = [];
	let other = 0;
	for (const e of errors) {
		const m = /^([^:\s][^:]*):(\d+):\d+: (error.*)$/.exec(e);
		if (m && resolve(crate, m[1]) === resolve(file)) own.push({ line: Number(m[2]), text: m[3] });
		else other += 1;
	}
	if (other) own.push({ line: 0, text: `and ${other} error${other === 1 ? "" : "s"} elsewhere in the crate (\`cargo check\` shows them)` });
	return own;
}

/**
 * A .rs file just written (process ticket 090): `cargo check` of its crate, errors only —
 * rustc's warnings are style here. The crate's own target/, as the model's cargo uses it.
 * Errors in other files of the crate come as one count line: they are often a file not
 * written yet. Only after an edit (lintCheck): the gate runs clippy on the whole crate.
 */
export function lintRust(path: string): Problem[] {
	if (extname(path).toLowerCase() !== ".rs" || !have("cargo")) return [];
	const crate = crateRoot(path);
	if (!crate) return [];
	const r = spawnSync("cargo", ["check", "--all-targets", "--message-format=short", "-q"], {
		cwd: crate,
		encoding: "utf8",
		timeout: CARGO_CHECK_MS,
		env: { ...process.env, CARGO_TERM_COLOR: "never", CARGO_TERM_PROGRESS_WHEN: "never" },
	});
	if (r.status === 0) return [];
	return parseRustc(cargoErrors(`${r.stdout ?? ""}${r.stderr ?? ""}`), crate, path);
}

/**
 * Undeclared names the file never assigns: they must come from elsewhere (an import,
 * a loaded script) or be defined with a real value. 0006g: told `io` was undeclared
 * (the page never loaded the socket.io client), the model wrote `var io = null`. A name
 * the file does assign is its own state with a forgotten declaration — 0006r2's
 * `myElement`, set to null on a reset — and `let x = null` is the right fix: no hint.
 */
export function foreignNames(ps: Problem[], text: string): string[] {
	const names = new Set<string>();
	for (const p of ps) {
		const m = UNDECLARED_NAME.exec(p.text);
		const name = m?.[1] ?? m?.[2];
		if (name && !assigns(text, name)) names.add(name);
	}
	return [...names];
}

function assigns(text: string, name: string): boolean {
	const n = name.replace(/[$]/g, "\\$");
	return new RegExp(`(?<![\\w$.])${n}\\s*(=(?![=>])|[-+*/%|&^]=|\\+\\+|--)|(\\+\\+|--)${n}\\b`).test(text);
}

/** At most the first MiB of a file, read in one bounded window; null if larger. */
function head(path: string): string | null {
	const buf = Buffer.alloc(HEAD_BYTES + 1);
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const n = readSync(fd, buf, 0, buf.length, 0);
		return n > HEAD_BYTES ? null : buf.toString("utf8", 0, n);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function lintNote(path: string, ps: Problem[], text: string | null = null): string {
	const lines = ps.slice(0, MAX_LINES).map((p) => (p.line ? `  line ${p.line}: ${p.text}` : `  ${p.text}`));
	if (ps.length > MAX_LINES) lines.push(`  ... ${ps.length - MAX_LINES} more`);
	const foreign = text === null ? [] : foreignNames(ps, text);
	const hint = foreign.length
		? `\n${foreign.map((n) => `\`${n}\``).join(", ")} ${foreign.length === 1 ? "is" : "are"} never assigned in this file: import, load the script that defines it, or define it with its real value. An empty declaration (\`let x = null\`) only hides the error.`
		: "";
	return `[lint] ${path}: ${ps.length} error${ps.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nFix these before running or reporting anything that depends on this file.${hint}`;
}

/** The check as a Pi extension: after every successful write or edit. */
export function lintCheck(pi: ExtensionAPI) {
	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const raw = (event.input as { path?: unknown })?.path;
		if (typeof raw !== "string" || !raw) return;
		const abs = resolve(ctx.cwd || process.cwd(), raw);
		const ps = extname(abs).toLowerCase() === ".rs" ? lintRust(abs) : lintFile(abs);
		if (!ps.length) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${lintNote(raw, ps, head(abs))}` }],
			structuredContent: event.structuredContent,
		};
	});
}
