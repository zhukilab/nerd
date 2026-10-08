// Anchors after a compaction (ticket 057 of the process). When pi-vcc
// compacts, the model keeps a summary and the recent tail; what it was doing and
// why goes with the rest. It could ask vcc_recall, but in the 60 runs of the A/B
// of 048 it never did (0 calls), and in the first acceptance run on main the
// summary's "Session Goal" was the plan step's answer form, not the operator's
// task. So the harness hands the anchors over itself, right after each
// compaction, as one message:
//
//   - the task in the operator's words (the first message), and the latest
//     operator message if there is a later one (a remark);
//   - PLAN.md, its head;
//   - notes/: each file with its first heading;
//   - the files changed since the task began (git: commits since the first
//     message, and what is not committed).
//
// Within NERD_ANCHORS_MAX_CHARS (4000, ~1.4K tokens); each part is cut to fit.
// The message goes in as the next thing the model reads (steer while it works,
// with the next turn when idle). NERD_ANCHORS=0 turns it off.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_ANCHORS_MAX = 4000;

export function anchorsOn(env = process.env): boolean {
	return env.NERD_ANCHORS !== "0";
}

export function anchorsMax(env = process.env): number {
	const n = Number(env.NERD_ANCHORS_MAX_CHARS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_ANCHORS_MAX;
}

function cut(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** notes/*.md (one level): "notes/<file> — <first heading or line>". */
export function notesIndex(cwd: string): string[] {
	const dir = join(cwd, "notes");
	if (!existsSync(dir)) return [];
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
	} catch {
		return [];
	}
	return names.map((n) => {
		let first = "";
		try {
			first = (readFileSync(join(dir, n), "utf8").split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "");
		} catch {
			/* a directory or unreadable: the name alone */
		}
		return first ? `notes/${n} — ${cut(first, 100)}` : `notes/${n}`;
	});
}

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
	return r.status === 0 ? r.stdout : "";
}

/** Files committed since `sinceIso` and those not committed, without duplicates. */
export function changedFiles(cwd: string, sinceIso?: string): string[] {
	const files = new Set<string>();
	if (sinceIso) {
		for (const l of git(cwd, ["log", `--since=${sinceIso}`, "--name-only", "--format="]).split("\n")) if (l.trim()) files.add(l.trim());
	}
	for (const l of git(cwd, ["status", "--porcelain", "--untracked-files=all"]).split("\n")) {
		const p = l.slice(3).trim();
		if (p) files.add(p.replace(/^.* -> /, ""));
	}
	return [...files].filter((f) => !f.startsWith("node_modules/")).sort();
}

export type AnchorInput = { cwd: string; task?: string; latest?: string; sinceIso?: string; max: number };

/** The anchors message, or undefined when there is nothing to say. */
export function anchorText(a: AnchorInput): string | undefined {
	const parts: string[] = [];
	const budget = a.max;
	if (a.task) parts.push(`The task, in the operator's words:\n${cut(a.task, Math.floor(budget * 0.25))}`);
	if (a.latest && a.latest !== a.task) parts.push(`The operator's latest message:\n${cut(a.latest, Math.floor(budget * 0.15))}`);
	const plan = join(a.cwd, "PLAN.md");
	if (existsSync(plan)) {
		try {
			parts.push(`PLAN.md:\n${cut(readFileSync(plan, "utf8"), Math.floor(budget * 0.3))}`);
		} catch {
			/* unreadable: left out */
		}
	}
	const notes = notesIndex(a.cwd);
	if (notes.length) parts.push(`notes/ (what you found and decided earlier; read a file when you need it):\n${cut(notes.join("\n"), Math.floor(budget * 0.1))}`);
	const changed = changedFiles(a.cwd, a.sinceIso);
	if (changed.length) parts.push(`Files changed since the task began:\n${cut(changed.join("\n"), Math.floor(budget * 0.1))}`);
	if (!parts.length) return undefined;
	const head = "[harness] The conversation was just compacted. To hold on to:";
	return cut(`${head}\n\n${parts.join("\n\n")}`, budget);
}

type Entry = { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: { type?: string }) => c.type === "text")
		.map((c: { text?: string }) => c.text ?? "")
		.join("\n");
}

/** As a Pi extension: one anchors message after each successful compaction. */
export function anchors(pi: ExtensionAPI, env = process.env) {
	const max = anchorsMax(env);
	pi.on("session_compact", (_event, ctx) => {
		const users = (ctx.sessionManager.getBranch() as Entry[]).filter((e) => e.type === "message" && e.message?.role === "user");
		const text = anchorText({
			cwd: ctx.cwd ?? process.cwd(),
			task: textOf(users[0]?.message?.content) || undefined,
			latest: users.length > 1 ? textOf(users.at(-1)?.message?.content) : undefined,
			sinceIso: users[0]?.timestamp,
			max,
		});
		if (!text) return;
		pi.sendMessage({ customType: "nerd-anchors", content: text, display: true }, { deliverAs: ctx.isIdle() ? "nextTurn" : "steer" });
	});
}
