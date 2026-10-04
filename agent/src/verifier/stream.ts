// Best-of-N on every agent step, as a Pi StreamFn (decision 0007): draw N
// candidate assistant messages from the underlying stream function, one after
// another (llama-server has one slot), let the verifier pick one, and hand the
// winner to the agent loop as a finished stream.
//
// Gate (cheap first): candidates that would do the same thing (same tool calls
// with the same arguments, or the same final text) are not compared at all.
// If the verifier fails, the first successful candidate is used and the
// failure is logged; the run does not stop because the judge broke.

import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { scorePair, type VerifierEndpoint } from "./llama.ts";
import type { Criterion } from "./pairwise.ts";
import { selectBest } from "./tournament.ts";

export const STEP_CRITERION: Criterion = {
	name: "Next step",
	description:
		"Which candidate next step is more likely to lead to the task being completed correctly? Prefer a step " +
		"that checks its work by running it, that acts on what the tool output actually said, and that does not " +
		"claim success the output does not show. A step that edits tests to make them pass, deletes failing " +
		"tests or ignores an error is worse than one that fixes the cause.",
};

export interface VerifierOptions extends VerifierEndpoint {
	n: number;
	pivots?: number;
	/** Characters of transcript history shown to the verifier (the newest kept). */
	historyChars?: number;
	logPath?: string;
	/**
	 * Which calls are agent steps. Pi sends compaction and branch summaries
	 * through the same stream function (agent-session.js: compact(), the
	 * summarizers); those must pass straight through, not be judged as steps.
	 */
	isAgentStep?: (messages: Message[]) => boolean;
	/** Draw and judge extra candidates only at forks (see stepKind). Default true. */
	forksOnly?: boolean;
}

export type StepKind = "finish" | "change" | "check" | "explore";

// A shell command that runs the work rather than looks around.
const CHECK_COMMAND =
	/\b(npm\s+(run\s+)?test|npx\s+(tsc|vitest|jest)|node\s+(--test\b|\S+\.[cm]?[jt]s)|pytest|python3?\s+\S+\.py|make\b|cargo\s+(test|run|build|check)|go\s+(test|run|build))/;

/**
 * What a step commits to. finish: ends the run with text. change: writes or
 * edits files. check: runs tests or the program. explore: everything else.
 * A step with several calls takes the strongest kind.
 */
export function stepKind(m: AssistantMessage): StepKind {
	const calls = m.content.filter((c) => c.type === "toolCall");
	if (calls.length === 0) return "finish";
	let kind: StepKind = "explore";
	for (const c of calls) {
		if (c.name === "write" || c.name === "edit") return "change";
		if (c.name === "bash" && CHECK_COMMAND.test(String((c.arguments as { command?: unknown }).command ?? ""))) kind = "check";
	}
	return kind;
}

/** All text of a system message: Pi puts the prompt into named `sections`, `content` may be empty. */
function systemText(m: Message): string {
	if (m.role !== "system") return "";
	return [text(m.content), ...Object.values(m.sections ?? {}).filter((s): s is string => typeof s === "string")].join("\n");
}

/** An agent step is a call whose leading system message carries the agent's own prompt. */
export function leadingSystemPromptIs(marker: string): (messages: Message[]) => boolean {
	return (messages) => {
		const first = messages[0];
		return first?.role === "system" && systemText(first).includes(marker);
	};
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image]" : ""))
		.join("");
}

/** How a candidate step reads to the judge: its text plus its tool calls. After TurboAgent's format_action. */
export function formatAction(m: AssistantMessage): string {
	const parts: string[] = [];
	for (const c of m.content) {
		if (c.type === "text" && c.text.trim()) parts.push(c.text.trim());
		else if (c.type === "toolCall") parts.push(`[tool_call: ${c.name}(${JSON.stringify(c.arguments)})]`);
	}
	return parts.join("\n") || "(empty reply)";
}

/** What the agent would actually do: equal signatures need no judging. */
export function actionSignature(m: AssistantMessage): string {
	const calls = m.content.filter((c) => c.type === "toolCall");
	if (calls.length) return JSON.stringify(calls.map((c) => [c.name, c.arguments]));
	return `text:${formatAction(m).replace(/\s+/g, " ").trim()}`;
}

/** The task (first user message) plus the newest history, flattened for the judge. */
export function formatHistory(messages: Message[], historyChars: number): string {
	const task = messages.find((m) => m.role === "user");
	const lines: string[] = [];
	for (const m of messages) {
		if (m === task || m.role === "system") continue;
		if (m.role === "user") lines.push(`[user] ${text(m.content)}`);
		else if (m.role === "assistant") lines.push(`[agent] ${formatAction(m)}`);
		else if (m.role === "toolResult")
			lines.push(`[${m.toolName} output${m.isError ? ", ERROR" : ""}]\n${text(m.content).slice(0, 2000)}`);
	}
	let history = lines.join("\n");
	if (history.length > historyChars) history = `[... earlier steps omitted ...]\n${history.slice(-historyChars)}`;
	return `${task ? text(task.content) : "(no task)"}\n\n**History:**\n${history || "(no steps yet)"}`;
}

function log(opts: VerifierOptions, entry: Record<string, unknown>) {
	if (opts.logPath) appendFileSync(opts.logPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

function finished(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
	} else {
		stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
	}
	stream.end(message);
	return stream;
}

export function verifierStreamFn(base: StreamFn, opts: VerifierOptions): StreamFn {
	if (opts.n <= 1) return base;
	return async (model, context, options) => {
		if (opts.isAgentStep && !opts.isAgentStep(context.messages as Message[])) {
			const first = (context.messages as Message[])[0];
			log(opts, {
				event: "passthrough",
				reason: "not an agent step",
				first: first ? { role: first.role, head: (systemText(first) || text(first.content)).slice(0, 160) } : null,
				roles: (context.messages as Message[]).map((m) => m.role).join(","),
			});
			return base(model, context, options);
		}
		const t0 = Date.now();
		const candidates: AssistantMessage[] = [];
		let lastFailure: AssistantMessage | undefined;
		for (let i = 0; i < opts.n; i++) {
			const m = await (await base(model, context, options)).result();
			if (m.stopReason === "error" || m.stopReason === "aborted") {
				lastFailure = m;
				if (m.stopReason === "aborted") break;
				continue;
			}
			candidates.push(m);
			// Forks only: an exploring step (read, ls, curl, grep) is cheap to get
			// wrong, and the next step shows it. Judge where the agent commits to
			// something — a change, a check, or "done". Seen live (ticket 012):
			// judging every step cost 1.5-2 min a step and only picked the better
			// of two detours.
			if (candidates.length === 1 && (opts.forksOnly ?? true) && stepKind(m) === "explore") {
				log(opts, { event: "skip", reason: "explore", genMs: Date.now() - t0 });
				return finished(m);
			}
		}
		const genMs = Date.now() - t0;
		if (candidates.length === 0) return finished(lastFailure as AssistantMessage);

		// Gate: collapse candidates that would do the same thing.
		const distinct: AssistantMessage[] = [];
		const seen = new Set<string>();
		for (const m of candidates) {
			const s = actionSignature(m);
			if (!seen.has(s)) {
				seen.add(s);
				distinct.push(m);
			}
		}
		if (distinct.length === 1) {
			log(opts, { event: "skip", reason: "identical", candidates: candidates.length, genMs });
			return finished(distinct[0]);
		}
		// Replies that all end the run with text alone differ only in wording:
		// the run ends the same way whichever is picked, so judging them is two
		// model calls for nothing. Judge only when some candidate acts.
		if (distinct.every((m) => !m.content.some((c) => c.type === "toolCall"))) {
			log(opts, { event: "skip", reason: "all final text", candidates: distinct.length, genMs });
			return finished(distinct[0]);
		}

		const task = formatHistory(context.messages as Message[], opts.historyChars ?? 12_000);
		const actions = distinct.map(formatAction);
		try {
			const result = await selectBest(
				distinct.length,
				async (a, b) => {
					const s = await scorePair(opts, task, actions[a], actions[b], STEP_CRITERION);
					return [s.ra, s.rb];
				},
				{ pivots: opts.pivots },
			);
			log(opts, {
				event: "select",
				best: result.best,
				preference: result.meanPreference.map((p) => Number(p.toFixed(3))),
				comparisons: result.comparisons.map(([a, b, ra, rb]) => [a, b, Number(ra.toFixed(3)), Number(rb.toFixed(3))]),
				actions: actions.map((s) => s.slice(0, 300)),
				genMs,
				verifyMs: Date.now() - t0 - genMs,
			});
			return finished(distinct[result.best]);
		} catch (e) {
			log(opts, { event: "verifier-error", error: String(e), genMs });
			return finished(distinct[0]);
		}
	};
}
