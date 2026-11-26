// The reflex by place of work (#1051): when the agent edits or writes a file, the notes and documents of its
// workspace that name that file are put in front of it — the lines that name it, once per document — and
// taken out of the context again a couple of turns later.
//
// Why this shape (nerd-meta bench/memory-replay, 2026-11-26): over 17 recorded sessions, a memory search on
// every step was "to the point" on ~1 % of steps with ~60 % noise and ~2 s per query; the documents that name
// the edited file came up about once a session, nearly all to the point (a decision about that very file), at
// no cost. No query, no model: an index of file names over the workspace's markdown.
//
// Shown: appended to the edit/write tool's result (as the loop guard's notes), so the model reads it before its
// next step. Not shown: a document already read in this stretch of context, the edited file itself, PLAN.md
// (re-read anyway), and names too common to mean one file. A compaction starts the count again (what was read
// is gone). Forgotten: the context handler cuts the reflex text out of tool results more than
// NERD_REFLEX_KEEP_TURNS assistant turns old. Kept short on purpose: changing an old message makes the model
// server re-read the context from there, so only the tail is ever changed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REFLEX_HEAD = "[reflex] Notes of this workspace that name this file";
const COMMON = new Set([
	"README.md", "CLAUDE.md", "AGENTS.md", "PLAN.md", "NOTES.md", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json",
	"main.rs", "lib.rs", "mod.rs", "index.ts", "index.js", "main.py", "__init__.py", "Dockerfile", "Makefile", ".gitignore",
	"compose.yaml", "docker-compose.yml", "settings.json", "tsconfig.json", "go.mod", "main.go",
]);
const NAME = /[\w.-]+\.(?:ts|tsx|js|mjs|py|sh|rs|md|json|ya?ml|toml|go|c|h|cpp|java|rb|sql|ps1)\b/g;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__"]);
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 900;

export function reflexOn(env = process.env): boolean {
	return env.NERD_REFLEX !== "0";
}

export function reflexKeepTurns(env = process.env): number {
	const n = Number(env.NERD_REFLEX_KEEP_TURNS ?? 2);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

type Mention = { doc: string; lines: string[] };

/** The workspace's markdown files (bounded), relative paths. */
export function markdownFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (out.length >= MAX_FILES || depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries.sort()) {
			if (SKIP_DIRS.has(e)) continue;
			const p = join(dir, e);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p, depth + 1);
			else if (e.endsWith(".md") && st.size <= MAX_BYTES && out.length < MAX_FILES) out.push(relative(root, p));
		}
	};
	walk(root, 0);
	return out;
}

/** file name -> the documents naming it, with the lines that do (at most 3 per document). */
export function buildIndex(root: string, files = markdownFiles(root)): Map<string, Mention[]> {
	const index = new Map<string, Mention[]>();
	for (const doc of files) {
		if (basename(doc) === "PLAN.md") continue;
		let text: string;
		try {
			text = readFileSync(join(root, doc), "utf8"); // whole-read: a markdown note under MAX_BYTES
		} catch {
			continue;
		}
		const byName = new Map<string, string[]>();
		for (const line of text.split("\n")) {
			for (const n of new Set(line.match(NAME) ?? [])) {
				if (COMMON.has(n)) continue;
				const ls = byName.get(n) ?? [];
				if (ls.length < 3) ls.push(line.trim().slice(0, 240));
				byName.set(n, ls);
			}
		}
		for (const [n, lines] of byName) {
			const list = index.get(n) ?? [];
			list.push({ doc, lines });
			index.set(n, list);
		}
	}
	return index;
}

/** The reflex note for an edited file, or undefined: documents not yet told nor read, not the file itself. */
export function reflexNote(index: Map<string, Mention[]>, file: string, done: Set<string>): string | undefined {
	const name = basename(file);
	if (COMMON.has(name)) return undefined;
	const fresh = (index.get(name) ?? []).filter((m) => !done.has(m.doc) && !file.endsWith(m.doc));
	if (fresh.length === 0) return undefined;
	let text = `${REFLEX_HEAD} (${name}) — what was decided or noted about it; read the whole note if it bears on this edit:`;
	for (const m of fresh) {
		done.add(m.doc);
		const add = `\n- ${m.doc}: ${m.lines.join(" … ")}`;
		if (text.length + add.length > MAX_TEXT) {
			text += `\n- … and ${fresh.length - fresh.indexOf(m)} more naming it`;
			break;
		}
		text += add;
	}
	return text;
}

type Block = { type: string; text?: string };
type Msg = { role?: string; content?: unknown };

/** `messages` with the reflex text cut out of tool results older than `keep` assistant turns; same array if none. */
export function forgetReflex<T>(messages: T[], keep: number): T[] {
	let turns = 0;
	let changed = false;
	const out = [...messages];
	for (let i = out.length - 1; i >= 0; i--) {
		const m = out[i] as Msg;
		if (m.role === "assistant") turns++;
		if (turns <= keep || m.role !== "toolResult" || !Array.isArray(m.content)) continue;
		const blocks = m.content as Block[];
		if (!blocks.some((b) => b.type === "text" && b.text?.includes(REFLEX_HEAD))) continue;
		const kept = blocks
			.map((b) => (b.type === "text" && b.text?.includes(REFLEX_HEAD) ? { ...b, text: b.text.slice(0, b.text.indexOf(REFLEX_HEAD)).trimEnd() } : b))
			.filter((b) => !(b.type === "text" && b.text === ""));
		out[i] = { ...m, content: kept } as T;
		changed = true;
	}
	return changed ? out : messages;
}

/** As a Pi extension. `root`: the workspace (the session's cwd by default). */
export function reflexExtension(pi: ExtensionAPI, opts: { keep?: number; root?: string } = {}) {
	const keep = opts.keep ?? reflexKeepTurns();
	let index: Map<string, Mention[]> | undefined;
	let root = opts.root;
	const done = new Set<string>();
	const reset = () => done.clear();
	pi.on("session_start", (_e, ctx) => {
		root ??= (ctx as unknown as { cwd?: string }).cwd ?? process.cwd();
		index = undefined;
		reset();
	});
	pi.on("session_compact", reset);
	pi.on("tool_result", (event, ctx) => {
		const name = event.toolName;
		const path = typeof event.input?.path === "string" ? event.input.path : typeof event.input?.file_path === "string" ? event.input.file_path : "";
		if (!path) return;
		root ??= (ctx as unknown as { cwd?: string }).cwd ?? process.cwd();
		const rel = path.startsWith("/") ? relative(root, path) : path;
		if (name === "read") {
			done.add(rel);
			return;
		}
		if (name !== "edit" && name !== "write") return;
		if (event.isError) return;
		// A note just written or changed is in the index from now on.
		if (!index || rel.endsWith(".md")) index = buildIndex(root);
		const note = reflexNote(index, rel, done);
		if (!note) return;
		pi.appendEntry("nerd-reflex", { file: rel, note });
		return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }], structuredContent: event.structuredContent };
	});
	pi.on("context", (event) => {
		const messages = forgetReflex(event.messages, keep);
		return messages === event.messages ? undefined : { messages };
	});
}
