// The DONE WHEN check of the Ralph loop (decision 0014, ticket 060 of the
// process): every item of the plan's "Done when" is a claim and the command
// that shows it, run by the harness in a clean clone of the committed project,
// with the same port guard as the done gate. An item without a command fails as
// "no check". The items are the ones the plan step committed (frozen): a later
// edit of PLAN.md is reported, not run; a check whose own files changed after it
// failed is reported too when it passes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { INSTALL_MS, isolatedEnv, listeningPorts, sh, TEST_MS, testExcerpt } from "./done-gate.ts";
import { PLAN_FILE } from "./plan-step.ts";

export interface DoneItem {
	claim: string;
	/** The shell command that exits 0 only if the claim holds; undefined: none given. */
	cmd?: string;
}

export interface ItemResult extends DoneItem {
	ok: boolean;
	why: string;
	/** The command's exit code (null: a timeout; undefined: not run). */
	rc?: number | null;
	/** The check itself is unusable (no command, cannot fail, does not parse): not run. */
	unusable?: boolean;
}

// A fact from the web shown in the README carries its quote and the page the
// harness saved (web-notes.ts): `> "<exact words>" — notes/web/<file>.md`. The
// quote must be in that file byte for byte (after the idea of SoL-Pi's
// receipts): a rule retold from memory, or a page never fetched, fails.
const QUOTE = /^>\s*"(.+)"\s*(?:—|–|--|-)\s*(notes\/web\/[\w.\-/]+\.md)\s*$/;

/** Failures of the README's quoted web facts in `app` (a clean clone). */
export function checkQuotes(app: string): string[] {
	const name = ["README.md", "readme.md", "Readme.md"].find((n) => existsSync(join(app, n)));
	if (!name) return [];
	const out: string[] = [];
	for (const line of readFileSync(join(app, name), "utf8").split("\n")) {
		const m = QUOTE.exec(line.trim());
		if (!m) continue;
		const [, quote, ref] = m;
		const file = join(app, ref);
		if (!existsSync(file)) out.push(`${name} quotes ${ref}, which is not in the commit (commit notes/web too).`);
		else if (!readFileSync(file, "utf8").includes(quote)) out.push(`${name} quotes "${quote.slice(0, 80)}" from ${ref}, but that page does not say it word for word.`);
	}
	return out;
}

// "- <claim> — check: `<command>`", also with words around the command, as the
// model writes it: "check: run `npm test` from the root" or "check: `npm test` → exit 0".
const CHECK = /^(.*?)\s*(?:—|–|--|-|:)?\s*check:[^`]*`([^`]+)`(.*)$/i;
// Two more forms from the stand of ticket 060 (2026-10-09), which used to become
// "no check": the command inside the claim and "check: exits 0" after it, and an
// item that is the command itself followed by "exits 0".
const SAYS_EXIT_0 = /\b(exits?|exit code|returns?)\b[^.;]*\b0\b|\b(passes|succeeds)\b/i;
const CHECK_AFTER = /^(.*?)`([^`]+)`(.*?)\s*(?:—|–|--|-|:)?\s*check:\s*(.*)$/i;
const CMD_ITEM = /^`([^`]+)`\s+((?:exits?|returns?)\s+(?:with\s+)?(?:code\s+)?0\b.*)$/i;
// And the command after "check:" with no backticks at all (the plan-only stand of
// ticket 065: kept so even after the lint's retry), when it starts like a command.
const COMMAND = /^(?:!\s*)?(?:node|npm|npx|test|\[|grep|git|sh|bash|curl|browse|cd|ls|diff|cmp|python3?|jq)\b/;
const BARE = new RegExp(`^(.*?)\\s*(?:—|–|--|-|:)?\\s*check:\\s*(${COMMAND.source.slice(1)}.*)$`, "i");
// From the stand of ticket 070: the closing backtick forgotten at the end of the
// line, and "<claim>: `<command>`" with no "check:" at all.
const UNCLOSED = /^(.*?)\s*(?:—|–|--|-|:)?\s*check:\s*`([^`]+)$/i;
const TAIL = /^([^`]*?)\s*(?:—|–|--|:)\s*`([^`]+)`\s*\.?$/;
// And "check:" inside the backticks: "- `check: npm test` → exit code 0".
const INSIDE = /^(.*?)`check:\s*([^`]+)`(.*)$/i;

export interface ParsedItem extends DoneItem {
	/** The words after the command ("prints 3", "exits 0"); "" when none. */
	after: string;
}

/** One Done when item (the text after "- "), in any of the forms above. */
export function parseItem(text: string): ParsedItem {
	const c = CHECK.exec(text);
	if (c) return { claim: c[1].trim(), cmd: c[2].trim(), after: c[3].trim() };
	const a = CHECK_AFTER.exec(text);
	if (a && !a[1].includes("`") && !a[3].includes("`") && SAYS_EXIT_0.test(a[4])) return { claim: a[1].trim(), cmd: a[2].trim(), after: a[4].trim() };
	const i = CMD_ITEM.exec(text);
	if (i) return { claim: text.trim(), cmd: i[1].trim(), after: i[2].trim() };
	const n = INSIDE.exec(text);
	if (n) return { claim: (n[1].trim() || text).trim(), cmd: n[2].trim(), after: n[3].trim() };
	const u = UNCLOSED.exec(text);
	if (u && COMMAND.test(u[2].trim())) return { claim: u[1].trim(), cmd: u[2].trim(), after: "" };
	const t = TAIL.exec(text);
	if (t && COMMAND.test(t[2].trim())) return { claim: t[1].trim(), cmd: t[2].trim(), after: "" };
	const b = text.includes("`") ? null : BARE.exec(text);
	if (b) return { claim: b[1].trim(), cmd: b[2].trim(), after: "" };
	return { claim: text.trim(), after: "" };
}

export interface DoneLine extends ParsedItem {
	/** 1-based line of the item in the plan. */
	line: number;
}

/** The items of a plan's "Done when" section with their lines; undefined: no such section. */
export function doneWhenLines(plan: string): DoneLine[] | undefined {
	const lines = plan.split("\n");
	const start = lines.findIndex((l) => /^#{1,3}\s*done when\s*$/i.test(l.trim()) || /^DONE WHEN\s*$/.test(l.trim()));
	if (start < 0) return undefined;
	const items: DoneLine[] = [];
	for (const [k, raw] of lines.slice(start + 1).entries()) {
		const l = raw.trim();
		if (/^#{1,3}\s/.test(l) || /^[A-Z][A-Z ]+$/.test(l)) break;
		const m = /^[-*]\s+(.*)$/.exec(l);
		if (m) items.push({ ...parseItem(m[1]), line: start + 2 + k });
	}
	return items;
}

/** The items of a plan's "Done when" section (PLAN.md as plan-step.ts writes it). */
export function parseDoneWhen(plan: string): DoneItem[] {
	return (doneWhenLines(plan) ?? []).map((i) => (i.cmd === undefined ? { claim: i.claim } : { claim: i.claim, cmd: i.cmd }));
}

/** Shell words of a command, quotes removed; undefined when it has expansions we do not follow. */
function shellWords(cmd: string): string[] | undefined {
	const words: string[] = [];
	let w = "";
	let inWord = false;
	for (let k = 0; k < cmd.length; k++) {
		const ch = cmd[k];
		if (ch === "'") {
			const end = cmd.indexOf("'", k + 1);
			if (end < 0) return undefined;
			w += cmd.slice(k + 1, end);
			k = end;
			inWord = true;
		} else if (ch === '"') {
			k++;
			for (; k < cmd.length && cmd[k] !== '"'; k++) {
				if (cmd[k] === "\\" && /["\\$`]/.test(cmd[k + 1] ?? "")) w += cmd[++k];
				else if (cmd[k] === "`" || (cmd[k] === "$" && cmd[k + 1] === "(")) return undefined;
				else w += cmd[k];
			}
			if (k >= cmd.length) return undefined;
			inWord = true;
		} else if (ch === "\\") {
			w += cmd[++k] ?? "";
			inWord = true;
		} else if (/\s/.test(ch) || /[;&|()<>]/.test(ch)) {
			if (inWord) words.push(w);
			w = "";
			inWord = false;
			if (!/\s/.test(ch)) words.push(ch);
		} else {
			w += ch;
			inWord = true;
		}
	}
	if (inWord) words.push(w);
	return words;
}

/** The scripts a command gives to `node -e`/`--eval`/`-p`, with whether they run as ES modules. */
export function nodeScripts(cmd: string): { body: string; module: boolean; prints: boolean }[] {
	const words = shellWords(cmd);
	if (!words) return [];
	const out: { body: string; module: boolean; prints: boolean }[] = [];
	for (let k = 0; k < words.length; k++) {
		if (words[k] !== "node") continue;
		let module = false;
		for (let j = k + 1; j < words.length && words[j].startsWith("-"); j++) {
			if (words[j] === "--input-type=module") module = true;
			if (["-e", "--eval", "-p", "--print"].includes(words[j]) && j + 1 < words.length) {
				const body = words[j + 1];
				module ||= /^\s*(import|export)\s|^\s*await\s|[;\n]\s*await\s/m.test(body);
				out.push({ body, module, prints: words[j] === "-p" || words[j] === "--print" });
				break;
			}
		}
	}
	return out;
}

const PRINTS = /console\.(log|error|info|warn|dir|table)\s*\(|process\.std(out|err)\.write\s*\(/;
const DECIDES = /process\.exit(Code)?\b|\bassert\b|\bthrow\b/;

/**
 * Why a check command can never fail, or undefined. A check that ends in
 * `|| true`, `|| echo …`, `; exit 0`, prints PASS/FAIL instead of exiting with
 * it, asserts with console.assert (which only logs), runs a node script that only
 * prints, or shows a git diff (exit 0 with or without changes) "passes" whatever
 * the project does. Our own rules (the idea, not the code, of a Pi package that
 * flags such commands): conservative, on the command text, top level only.
 */
export function unfailable(cmd: string): string | undefined {
	const c = cmd.replace(/\s+/g, " ").trim();
	// The last top-level step after ; or || decides the exit code.
	if (/(\|\||;)\s*(true|:|exit 0)\s*$/.test(c)) return "it ends in a step that always succeeds (`|| true`, `; exit 0`)";
	if (/(\|\||;)\s*(echo|printf)\b[^;&|]*$/.test(c)) return "it ends in an echo/printf, which always exits 0";
	if (/&&\s*(echo|printf)\b[^|;]*\|\|\s*(echo|printf)\b/.test(c)) return "both of its outcomes are an echo (`&& echo PASS || echo FAIL`): the result is printed, not returned";
	if (/\|\|\s*(echo|printf|true|:)\b/.test(c)) return "a failure inside it is swallowed (`|| echo …`, `|| true`)";
	if (/console\.assert\s*\(/.test(c) && !/process\.exit(Code)?\b|assert\.|throw\b/.test(c)) return "console.assert only logs: a failed assertion still exits 0";
	if (/\|\s*[^|]*\$\?/.test(c)) return "it reads $? after a pipe, which is the last command's code, not the check's";
	if (/(^|[;&|]\s*)git diff\b/.test(c) && !/--exit-code|--quiet/.test(c) && !/git diff[^;&|]*\|/.test(c)) return "`git diff` exits 0 whether or not there are changes (add --exit-code or --quiet)";
	for (const s of nodeScripts(cmd)) {
		if ((s.prints || PRINTS.test(s.body)) && !DECIDES.test(s.body) && !/\|\s*grep\b/.test(c)) {
			return "its node script only prints: the harness reads the exit code, not the output (exit non-zero with process.exit, assert or throw)";
		}
	}
	return undefined;
}

/** Why a check command cannot even start (its own syntax), or undefined. Runs no part of it. */
export function syntaxError(cmd: string): string | undefined {
	const shell = spawnSync("sh", ["-n", "-c", cmd], { encoding: "utf8", timeout: 10_000 });
	if (shell.status !== 0) return `the command does not parse in the shell: ${(shell.stderr || "").trim().split("\n")[0]}`;
	for (const s of nodeScripts(cmd)) {
		const dir = mkdtempSync(join(tmpdir(), "nerd-check-"));
		try {
			// As node itself does for -e: CommonJS first, then an ES module (top-level await, import).
			const check = (ext: string) => {
				const file = join(dir, `check.${ext}`);
				writeFileSync(file, s.body);
				return spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10_000 });
			};
			const first = check(s.module ? "mjs" : "cjs");
			if (first.status !== 0 && (s.module || check("mjs").status !== 0)) {
				const err = (first.stderr || "").split("\n").find((l) => /Error/.test(l)) ?? "a syntax error";
				return `its node script does not parse: ${err.trim()}`;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return undefined;
}

type Git =(cwd: string, ...args: string[]) => Promise<{ code: number | null; out: string }>;
const git: Git = (cwd, ...args) => sh("git", args, cwd, 30_000);

/** PLAN.md as the plan step committed it (the first commit that added it), or undefined. */
export async function frozenPlan(cwd: string): Promise<string | undefined> {
	const added = await git(cwd, "log", "--diff-filter=A", "--format=%H", "--", PLAN_FILE);
	const first = added.out.trim().split("\n").filter(Boolean).at(-1);
	if (added.code !== 0 || !first) return undefined;
	const top = await git(cwd, "rev-parse", "--show-toplevel");
	const path = relative(top.out.trim(), join(cwd, PLAN_FILE));
	const shown = await git(cwd, "show", `${first}:${path}`);
	return shown.code === 0 ? shown.out : undefined;
}

/** Items of the current PLAN.md that are not among the frozen ones (an edit of the checks). */
export function changedItems(frozen: DoneItem[], now: DoneItem[]): DoneItem[] {
	const key = (i: DoneItem) => `${i.claim}\u0000${i.cmd ?? ""}`;
	const was = new Set(frozen.map(key));
	return now.filter((i) => !was.has(key(i)));
}

/** Paths of the repository that a command names (to notice a check edited to pass). */
export function filesOf(cmd: string, root: string): string[] {
	return [...new Set(cmd.split(/[\s'"=;|&()<>]+/).filter((w) => /[./]/.test(w) && !w.startsWith("-")))]
		.map((w) => w.replace(/^\.\//, ""))
		.filter((w) => !w.startsWith("/") && existsSync(join(root, w)) && statSync(join(root, w)).isFile());
}

export function hashFiles(files: string[], root: string): string {
	const h = createHash("sha256");
	for (const f of [...files].sort()) h.update(f).update("\0").update(readFileSync(join(root, f)));
	return h.digest("hex");
}

/** Runs every item in a clean clone of HEAD (npm ci/install first when there is a
 * package.json), then checks the README's quoted web facts (checkQuotes). */
export async function runDoneWhen(cwd: string, items: DoneItem[], timeoutMs = TEST_MS): Promise<ItemResult[]> {
	const top = await git(cwd, "rev-parse", "--show-toplevel");
	if (top.code !== 0) return items.map((i) => ({ ...i, ok: false, why: "not a git repository" }));
	const root = top.out.trim();
	const sub = relative(root, cwd);
	const blocked = listeningPorts();
	const tmp = mkdtempSync(join(tmpdir(), "nerd-ralph-"));
	try {
		const clone = await sh("git", ["clone", "-q", "--no-hardlinks", root, join(tmp, "app")], tmp, 120_000);
		if (clone.code !== 0) return items.map((i) => ({ ...i, ok: false, why: "a clean clone failed" }));
		const app = join(tmp, "app", sub);
		if (existsSync(join(app, "package.json"))) {
			const lock = existsSync(join(app, "package-lock.json"));
			await sh("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund", "--prefer-offline"], app, INSTALL_MS);
		}
		const out: ItemResult[] = [];
		for (const i of items) {
			if (!i.cmd) {
				out.push({ ...i, ok: false, unusable: true, why: "no check: the plan gives no command for this item" });
				continue;
			}
			const never = unfailable(i.cmd);
			if (never) {
				out.push({ ...i, ok: false, unusable: true, why: `the check cannot fail: ${never}. A check must exit non-zero when the claim is false` });
				continue;
			}
			const broken = syntaxError(i.cmd);
			if (broken) {
				out.push({ ...i, ok: false, unusable: true, why: `the check is broken: ${broken}` });
				continue;
			}
			const r = await sh("sh", ["-c", i.cmd], app, timeoutMs, isolatedEnv(blocked, { CI: "1" }));
			out.push({ ...i, ok: r.code === 0, rc: r.code, why: r.code === 0 ? "" : `exited with ${r.code ?? "a timeout"}:\n${testExcerpt(r.out)}` });
		}
		for (const q of checkQuotes(app)) out.push({ claim: "the web facts the README quotes", ok: false, why: q });
		return out;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
