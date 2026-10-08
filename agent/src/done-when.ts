// The DONE WHEN check of the Ralph loop (decision 0014, ticket 060 of the
// process): every item of the plan's "Done when" is a claim and the command
// that shows it, run by the harness in a clean clone of the committed project,
// with the same port guard as the done gate. An item without a command fails as
// "no check". The items are the ones the plan step committed (frozen): a later
// edit of PLAN.md is reported, not run; a check whose own files changed after it
// failed is reported too when it passes.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
const CHECK = /^(.*?)\s*(?:—|–|--|-|:)?\s*check:[^`]*`([^`]+)`.*$/i;

/** The items of a plan's "Done when" section (PLAN.md as plan-step.ts writes it). */
export function parseDoneWhen(plan: string): DoneItem[] {
	const lines = plan.split("\n");
	const start = lines.findIndex((l) => /^#{1,3}\s*done when\s*$/i.test(l.trim()) || /^DONE WHEN\s*$/.test(l.trim()));
	if (start < 0) return [];
	const items: DoneItem[] = [];
	for (const raw of lines.slice(start + 1)) {
		const l = raw.trim();
		if (/^#{1,3}\s/.test(l) || /^[A-Z][A-Z ]+$/.test(l)) break;
		const m = /^[-*]\s+(.*)$/.exec(l);
		if (!m) continue;
		const c = CHECK.exec(m[1]);
		items.push(c ? { claim: c[1].trim(), cmd: c[2].trim() } : { claim: m[1].trim() });
	}
	return items;
}

/**
 * Why a check command can never fail, or undefined. A check that ends in
 * `|| true`, `|| echo …`, `; exit 0`, prints PASS/FAIL instead of exiting with
 * it, or asserts with console.assert (which only logs) "passes" whatever the
 * project does. Our own rules (the idea, not the code, of a Pi package that
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
				out.push({ ...i, ok: false, why: "no check: the plan gives no command for this item" });
				continue;
			}
			const never = unfailable(i.cmd);
			if (never) {
				out.push({ ...i, ok: false, why: `the check cannot fail: ${never}. A check must exit non-zero when the claim is false` });
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
