// A scout (process ticket 042): the model hands a question about the project to a helper
// that reads in a context of its own, and gets back a file of findings instead of the
// files it would have read. On one llama-server slot this was ruled out by the prefix
// cache (decision 0007); with llama-server's prompt cache in RAM (NERD_CACHE_RAM, on by
// default) coming back to a 61K-token context after another one costs 4 s, not 4 min.
//
//   NERD_SCOUT=1   the work and the plan step have `scout` (headless only, as
//                  NERD_RALPH_FRESH: the helper is a new Pi session of the run).
//                  The helper has read, ls, grep and find, the loop guard and the
//                  output cap, a system prompt of its own, the same model.
//   NERD_SCOUT_MAX_CALLS  its tool calls (default 25); NERD_SCOUT_MAX_MINUTES its wall
//                  clock (default 15). Past either its tools go away and it is told to
//                  write what it found; 5 min later it is stopped.
//
// The findings go to notes/scout/NNN.md of the project (the question on top); the tool
// returns the path and the head of the file. @gotgenes/pi-subagents was read and left
// out: ~1K tokens of tool text with no compact mode, the helper without our extensions,
// the result only as text (process ticket 042, «Ход»).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const SCOUT_TOOL = "scout";
export const SCOUT_DIR = "notes/scout";
const HEAD_CHARS = 1500;

export function scoutOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_SCOUT === "1";
}

export function scoutLimits(env: Record<string, string | undefined> = process.env) {
	const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
	return { maxCalls: n(env.NERD_SCOUT_MAX_CALLS, 25), maxMinutes: n(env.NERD_SCOUT_MAX_MINUTES, 15) };
}

export const SCOUT_DESCRIPTION =
	"Hands a question about this project (where something is, how something works, what uses what) to a helper " +
	"that reads the files with read, ls, grep and find in a context of its own, and writes its findings to " +
	`${SCOUT_DIR}/NNN.md. Returns that path and the head of the file. It changes nothing. Use it instead of ` +
	"reading many files yourself; ask one clear question per call.";

export const SCOUT_SYSTEM = [
	"You are a scout for a coding agent. You get one question about the project in the current directory.",
	"Answer it by reading: read, ls, grep and find are your tools; you cannot change anything.",
	"Read only what the question needs. When you know the answer, stop calling tools and write it:",
	"the answer first, in a few sentences; then the facts it rests on, each with its file path and line numbers;",
	"then what you could not find. No greetings, no plan, no repetition of the question.",
].join("\n");

export const SCOUT_STOP =
	"Your budget for reading is used up. Do not call any tool. Write your findings now: the answer, the facts with " +
	"file paths and line numbers, and what you could not find.";

/** What the tool needs of the helper's Pi session (AgentSession). */
export interface ScoutSession {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<unknown>;
	abort(): Promise<void>;
	setActiveToolsByName(names: string[]): void;
	subscribe(listener: (event: { type: string }) => void): () => void;
	readonly messages: unknown[];
	dispose(): void;
}

function lastText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const t = m.content
			.filter((c: { type?: string }) => c.type === "text")
			.map((c: { text?: string }) => c.text ?? "")
			.join("\n")
			.trim();
		if (t) return t;
	}
	return "";
}

/** The next free NNN.md in notes/scout/ of `cwd`. */
export function nextScoutFile(cwd: string): string {
	const dir = join(cwd, SCOUT_DIR);
	mkdirSync(dir, { recursive: true });
	const used = readdirSync(dir)
		.map((f) => /^(\d+)\.md$/.exec(f)?.[1])
		.filter((n): n is string => !!n)
		.map(Number);
	const next = (used.length ? Math.max(...used) : 0) + 1;
	return join(SCOUT_DIR, `${String(next).padStart(3, "0")}.md`);
}

export interface ScoutRun {
	findings: string;
	calls: number;
	stopped: "self" | "calls" | "minutes";
}

/** Runs one question through a fresh helper session; the budget ends its reading, then the session. */
export async function runScout(s: ScoutSession, question: string, limits = scoutLimits(), signal?: AbortSignal): Promise<ScoutRun> {
	let calls = 0;
	let stopped: ScoutRun["stopped"] = "self";
	let hard: ReturnType<typeof setTimeout> | undefined;
	const stop = (why: ScoutRun["stopped"]) => {
		if (stopped !== "self") return;
		stopped = why;
		s.setActiveToolsByName([]);
		void s.steer(SCOUT_STOP);
		hard = setTimeout(() => void s.abort(), 5 * 60_000);
	};
	const unsub = s.subscribe((e) => {
		if (e.type === "tool_execution_end" && ++calls >= limits.maxCalls) stop("calls");
	});
	const clock = limits.maxMinutes > 0 ? setTimeout(() => stop("minutes"), limits.maxMinutes * 60_000) : undefined;
	const onAbort = () => void s.abort();
	signal?.addEventListener("abort", onAbort);
	try {
		await s.prompt(question);
	} finally {
		unsub();
		if (clock) clearTimeout(clock);
		if (hard) clearTimeout(hard);
		signal?.removeEventListener("abort", onAbort);
	}
	return { findings: lastText(s.messages), calls, stopped };
}

/** The tool's reply: where the findings are and their head. */
export function scoutReply(path: string, r: ScoutRun): string {
	const head = r.findings.length > HEAD_CHARS ? `${r.findings.slice(0, HEAD_CHARS)}\n[… the rest is in the file]` : r.findings;
	const why = r.stopped === "self" ? "" : `; stopped by its ${r.stopped === "calls" ? "call" : "time"} budget`;
	return `Findings in ${path} (${r.calls} tool calls${why}):\n\n${head}`;
}

/** `scout`, for customTools (headless): `spawn` makes the helper's session. */
export function scoutTool(cwd: string, spawn: () => Promise<ScoutSession>, env: Record<string, string | undefined> = process.env) {
	return defineTool({
		name: SCOUT_TOOL,
		label: "scout",
		description: SCOUT_DESCRIPTION,
		parameters: Type.Object({ question: Type.String({ description: "One question about the project" }) }),
		async execute(_id, params, signal) {
			const s = await spawn();
			try {
				const r = await runScout(s, params.question, scoutLimits(env), signal);
				if (!r.findings) {
					return { content: [{ type: "text" as const, text: `The scout found nothing to report (${r.calls} tool calls).` }], details: undefined, isError: true };
				}
				const path = nextScoutFile(cwd);
				writeFileSync(join(cwd, path), `# ${params.question.trim()}\n\n${r.findings}\n`);
				return { content: [{ type: "text" as const, text: scoutReply(path, r) }], details: undefined };
			} finally {
				s.dispose();
			}
		},
	});
}
