// The agora channel (process ticket 095; the wire is agora-doc docs/PI-CHANNEL.md v1):
// a session manager on the host (agora) listens on a unix socket mounted into the
// container, and this extension connects to it when AGORA_PI_CHANNEL (agora's name since
// its cc1fced) or the older NERD_AGORA_CHANNEL names it.
//
//   - events under Claude Code's hook names (SessionStart, UserPromptSubmit, PostToolUse,
//     Stop, PreCompact, PostCompact, SessionEnd) and the context share after each turn;
//   - letters in, by the sender's ring (letter-delivery.ts, ticket 101), then `ack`. A
//     prompt: the manager's ready text with sendUserMessage; in the TUI an idle session
//     gets it as a prompt; the headless run (mode "run") drives its own prompts, so there
//     a letter waits for the next turn and goes in as a follow-up (a steer if urgent).
//     Injected: into the context without a turn, at once. Triaged: a short request to the
//     model first, then one of those or dropped. Held during a compaction in all;
//   - send_letter: the model's letter, sent by the manager on the agent's behalf.
//
// One connection per process: a Ralph round in a new session (run.ts) makes a new
// instance of this extension in the same process, and the newest one takes the
// connection and the letters over; older ones go silent. The scout's helper session
// (scout.ts) loads its own extensions only, so it has no channel.

import { createConnection, type Socket } from "node:net";
import { StringEnum, Type, type Api, type Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { defineTool, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type Act, injectText, TRIAGE_SYSTEM, triagedAct, triagePrompt, wayOf } from "./letter-delivery.ts";
import { letterPrompt, taskSubject } from "./plan-step.ts";
import { sessionStats } from "./session-stats.ts";

export const SEND_LETTER_TOOL = "send_letter";
/** A longer line breaks the wire (PI-CHANNEL §1). */
export const MAX_LINE = 1 << 20;
const STOP_CHARS = 8192;
const EXT_VERSION = "0.2.1";
/** The triage's reply: a word and a few lines; thinking is off (no reasoning asked). */
const TRIAGE_TOKENS = 600;
const TRIAGE_MS = 5 * 60_000;
/** The verifier's api (extension.ts): the triage asks the server once, not best-of-N. */
const VERIFIED_API = "nerd-verified";

export type Mode = "tui" | "run";
export type Msg = { t: string; [k: string]: unknown };

/** The channel's socket path, or undefined: no channel, nothing of this file loads. */
export function agoraChannelPath(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.AGORA_PI_CHANNEL || env.NERD_AGORA_CHANNEL || undefined;
}

/** The instance that owns the process's connection. */
interface Owner {
	hello(): Msg;
	letter(m: Msg): void;
}

export interface ChannelOptions {
	minDelayMs?: number;
	maxDelayMs?: number;
	answerMs?: number;
	log?: (s: string) => void;
	/** The settings the ring's way is read from at each letter (default process.env). */
	env?: Record<string, string | undefined>;
}

/** The process's one connection: reconnects with a doubling pause, queues until `welcome`. */
export class Channel {
	owner?: Owner;
	/** Ids of letters already put into a session: a repeat is acked, not injected again. */
	readonly injected = new Set<string>();
	log: (s: string) => void;
	private sock?: Socket;
	private buf = "";
	private welcomed = false;
	private closed = false;
	private delay: number;
	private timer?: NodeJS.Timeout;
	private outbox: Msg[] = [];
	private nextId = 1;
	private pending = new Map<string, { done: (m: Msg) => void; timer: NodeJS.Timeout }>();
	private readonly o: Required<Omit<ChannelOptions, "log" | "env">>;

	readonly path: string;

	constructor(path: string, opts: ChannelOptions = {}) {
		this.path = path;
		this.o = { minDelayMs: opts.minDelayMs ?? 1000, maxDelayMs: opts.maxDelayMs ?? 30_000, answerMs: opts.answerMs ?? 30_000 };
		this.delay = this.o.minDelayMs;
		this.log = opts.log ?? ((s) => console.error(`[agora channel] ${s}`));
	}

	get connected(): boolean {
		return this.welcomed;
	}

	/** The newest instance takes the connection over; the first one opens it. */
	attach(owner: Owner): void {
		this.owner = owner;
		if (!this.sock && !this.timer && !this.closed) this.connect();
	}

	send(m: Msg): void {
		if (this.welcomed && this.sock) this.write(m);
		else {
			this.outbox.push(m);
			if (this.outbox.length > 200) this.outbox.shift();
		}
	}

	/** send_letter: the answer with the same id, or an error after answerMs or a break. */
	request(m: Msg): Promise<Msg> {
		const id = String(this.nextId++);
		return new Promise((done) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				done({ t: "letter_result", id, ok: false, error: "manager did not answer" });
			}, this.o.answerMs);
			this.pending.set(id, { done, timer });
			if (!this.welcomed) {
				this.settle(id, { t: "letter_result", id, ok: false, error: "manager did not answer (no channel)" });
				return;
			}
			this.write({ ...m, id });
		});
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		this.sock?.destroy();
		for (const id of [...this.pending.keys()]) this.settle(id, { t: "letter_result", id, ok: false, error: "manager did not answer" });
	}

	private write(m: Msg): void {
		this.sock?.write(`${JSON.stringify(m)}\n`);
	}

	private settle(id: string, m: Msg): void {
		const p = this.pending.get(id);
		if (!p) return;
		clearTimeout(p.timer);
		this.pending.delete(id);
		p.done(m);
	}

	private connect(): void {
		this.timer = undefined;
		const s = createConnection(this.path);
		this.sock = s;
		this.buf = "";
		this.welcomed = false;
		s.setEncoding("utf8");
		s.on("connect", () => {
			if (this.owner) this.write(this.owner.hello());
		});
		s.on("data", (chunk: string) => this.data(chunk));
		s.on("error", () => {});
		s.on("close", () => {
			if (this.sock !== s) return;
			const was = this.welcomed;
			this.sock = undefined;
			this.welcomed = false;
			for (const id of [...this.pending.keys()]) this.settle(id, { t: "letter_result", id, ok: false, error: "manager did not answer" });
			if (was) this.log("connection lost; reconnecting");
			if (this.closed) return;
			this.timer = setTimeout(() => this.connect(), this.delay);
			this.timer.unref();
			this.delay = Math.min(this.delay * 2, this.o.maxDelayMs);
		});
	}

	private data(chunk: string): void {
		this.buf += chunk;
		for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (line.trim()) this.line(line);
		}
		if (this.buf.length > MAX_LINE) {
			this.write({ t: "error", error: "line longer than 1 MiB", about: this.buf.slice(0, 80) });
			this.sock?.destroy();
		}
	}

	private line(line: string): void {
		let m: Msg;
		try {
			m = JSON.parse(line);
			if (typeof m?.t !== "string") throw new Error();
		} catch {
			this.write({ t: "error", error: "line is not JSON", about: line.slice(0, 80) });
			return;
		}
		switch (m.t) {
			case "welcome":
				this.welcomed = true;
				this.delay = this.o.minDelayMs;
				this.log(`connected as ${m.agent ?? "?"}`);
				for (const q of this.outbox.splice(0)) this.write(q);
				return;
			case "refused":
				this.log(`refused: ${m.error ?? "no reason"}`);
				return;
			case "letter":
				if (typeof m.id !== "string" || typeof m.text !== "string") {
					this.write({ t: "error", error: "letter without id or text", about: "letter" });
					return;
				}
				if (this.injected.has(m.id)) this.write({ t: "ack", id: m.id });
				else this.owner?.letter(m);
				return;
			case "letter_result":
				this.settle(String(m.id), m);
				return;
			case "error":
				this.log(`manager: ${m.error ?? "error"}${m.about ? ` (${m.about})` : ""}`);
				return;
			default:
				this.log(`unknown message ${m.t}`);
		}
	}
}

const KEY = Symbol.for("nerd.agoraChannel");

/** The process's channel to `path`, made on first use. */
export function processChannel(path: string, opts?: ChannelOptions): Channel {
	const g = globalThis as { [KEY]?: Channel };
	if (!g[KEY] || g[KEY].path !== path) g[KEY] = new Channel(path, opts);
	return g[KEY];
}

/** The end of the process's channel (run.ts, at the end of the run); none: nothing. */
export function closeProcessChannel(): void {
	const g = globalThis as { [KEY]?: Channel };
	g[KEY]?.close();
	delete g[KEY];
}

type Entry = { type?: string; message?: { role?: string; content?: unknown } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: { type?: string }) => c.type === "text")
		.map((c: { text?: string }) => c.text ?? "")
		.join("\n");
}

function lastAssistantText(ctx: ExtensionContext): string {
	const last = (ctx.sessionManager.getBranch() as Entry[]).filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1);
	return textOf(last?.message?.content).slice(-STOP_CHARS);
}

const DESCRIPTION =
	"Send a letter through agora. to: a participant's name or JID; re: the id of the letter you answer. The letter goes out under your own name.";

/** The channel for one session: `mode` is "tui" (tui.ts) or "run" (run.ts). */
export function agoraChannel(mode: Mode, path: string, opts?: ChannelOptions): ExtensionFactory {
	return (pi) => {
		const ch = processChannel(path, opts);
		let ctx: ExtensionContext | undefined;
		let running = false;
		let compacting = false;
		let outcome: string | undefined;
		let sorting = false;
		const env = opts?.env ?? process.env;
		const held: { m: Msg; act?: Act }[] = [];
		// Pi's screen is not stderr's: the TUI shows the channel's notes as notifications.
		if (mode === "tui" && !opts?.log) ch.log = (s) => ctx?.ui.notify(`agora: ${s}`, "info");

		const me: Owner = {
			hello: () => ({
				t: "hello",
				v: 1,
				mode,
				ext: EXT_VERSION,
				...(ctx ? { session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd } : {}),
				idle: ctx ? ctx.isIdle() : true,
				// The manager stops a run with SIGTERM to this pid (PI-CHANNEL amendment 3).
				pid: process.pid,
			}),
			letter: (m) => {
				held.push({ m });
				deliver();
			},
		};
		const mine = () => ch.owner === me;
		const event = (hook: string, fields: Record<string, unknown> = {}) => {
			if (mine()) ch.send({ t: "event", hook, at: new Date().toISOString(), ...fields });
		};
		const context = () => {
			const u = ctx?.getContextUsage();
			// #993: the session's peak, the last reply's speed and MTP acceptance, the uptime (session-stats.ts).
			if (u && mine()) ch.send({ t: "context", tokens: u.tokens, window: u.contextWindow, percent: u.percent, ...sessionStats().contextEvent() });
		};
		// The triage's one request: the session's model, its plain stream, no tools, thinking off.
		const triage = async (m: Msg, c: ExtensionContext): Promise<Act> => {
			const model = c.model;
			if (!model) return triagedAct(m, undefined, "no model");
			try {
				const auth = await c.modelRegistry.getApiKeyAndHeaders(model);
				const r = await completeSimple(
					(model.api === VERIFIED_API ? { ...model, api: "openai-completions" } : model) as Model<Api>,
					{ systemPrompt: TRIAGE_SYSTEM, messages: [{ role: "user", content: triagePrompt(m, lastAssistantText(c)), timestamp: Date.now() }] },
					{ ...(auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {}), maxTokens: TRIAGE_TOKENS, signal: AbortSignal.timeout(TRIAGE_MS) },
				);
				if (r.stopReason === "error" || r.stopReason === "aborted") return triagedAct(m, undefined, r.errorMessage ?? r.stopReason);
				return triagedAct(m, textOf(r.content));
			} catch (e) {
				return triagedAct(m, undefined, e instanceof Error ? e.message : String(e));
			}
		};
		// One letter at a time: the manager sends the next after the ack.
		const deliver = () => {
			if (sorting || !held.length || !ctx || compacting || !mine()) return;
			const h = held[0];
			if (!h.act) {
				const way = wayOf(h.m, env);
				if (way === "triage") {
					sorting = true;
					void triage(h.m, ctx).then((act) => {
						h.act = act;
						sorting = false;
						deliver();
					});
					return;
				}
				h.act = way === "prompt" ? { way, text: String(h.m.text) } : { way, text: injectText(h.m) };
			}
			const m = h.m;
			const act = h.act;
			if (act.way === "prompt" && mode === "run" && !running) return;
			held.shift();
			if (act.way === "prompt") {
				const idle = mode === "tui" && ctx.isIdle();
				// A prompt of its own: a new task only by its subject (plan-step.ts).
				if (idle) letterPrompt(act.text, taskSubject(m.subject));
				pi.sendUserMessage(act.text, idle ? undefined : { deliverAs: m.urgent === true ? "steer" : "followUp" });
			} else if (act.way === "inject") {
				// No turn: pending until the running turn ends, else appended to the session now.
				pi.sendMessage(
					{ customType: "agora-letter", content: act.text, display: true, details: { id: m.id, from: m.from, ring: m.ring, kind: m.kind, ...(act.log ? { note: act.log } : {}) } },
					{ triggerTurn: false },
				);
				if (act.log) ch.log(`letter ${m.id} from ${m.from}: ${act.log}`);
			} else {
				// Read by triage and not worth the tokens: acked all the same (PI-CHANNEL amendment 3), logged here.
				pi.appendEntry("agora-letter-dropped", { id: m.id, from: m.from, subject: m.subject, ring: m.ring, why: act.why });
				ch.log(`letter ${m.id} from ${m.from} dropped by triage: ${act.why}`);
			}
			ch.injected.add(String(m.id));
			ch.send({ t: "ack", id: m.id });
			// No turn follows an inject or a drop: a letter already held behind it goes on now.
			if (act.way !== "prompt") deliver();
		};

		pi.on("session_start", (e, c) => {
			ctx = c;
			ch.attach(me);
			event("SessionStart", { source: e.reason, session_id: c.sessionManager.getSessionId(), session_file: c.sessionManager.getSessionFile(), cwd: c.cwd });
			deliver();
		});
		pi.on("agent_start", (_e, c) => {
			ctx = c;
			running = true;
			compacting = false;
			outcome = undefined;
			event("UserPromptSubmit");
			deliver();
		});
		pi.on("tool_execution_end", (e) => event("PostToolUse", { tool_name: e.toolName, is_error: e.isError }));
		pi.on("turn_end", (_e, c) => {
			ctx = c;
			context();
		});
		pi.on("agent_before_settle", (e) => {
			outcome = e.outcome;
		});
		pi.on("agent_settled", (_e, c) => {
			ctx = c;
			running = false;
			compacting = false;
			event("Stop", { last_assistant_message: lastAssistantText(c), ...(outcome ? { outcome } : {}) });
			deliver();
		});
		pi.on("session_before_compact", (e) => {
			compacting = true;
			event("PreCompact", { trigger: e.reason });
		});
		pi.on("session_compact", (e, c) => {
			ctx = c;
			compacting = false;
			event("PostCompact", { trigger: e.reason });
			context();
			deliver();
		});
		pi.on("session_compact_failed", (e, c) => {
			ctx = c;
			compacting = false;
			event("PostCompact", { trigger: e.reason, failed: true, ...(e.errorMessage ? { error: e.errorMessage } : {}), aborted: e.aborted, will_retry: e.willRetry });
			context();
			deliver();
		});
		pi.on("session_shutdown", (e) => event("SessionEnd", { reason: e.reason }));

		pi.registerTool(
			defineTool({
				name: SEND_LETTER_TOOL,
				label: "send_letter",
				description: DESCRIPTION,
				parameters: Type.Object({
					to: Type.String(),
					subject: Type.String(),
					body: Type.String(),
					// The kinds the manager lets an agent send (PI-CHANNEL amendment 2).
					kind: Type.Optional(StringEnum(["note", "todo", "status", "answer"])),
					re: Type.Optional(Type.String()),
				}),
				async execute(_id, p) {
					const r = await ch.request({ t: "send_letter", ...p });
					const text = r.ok === true ? `sent, id ${r.letter_id}` : String(r.error ?? "not sent");
					return { content: [{ type: "text" as const, text }], details: undefined, isError: r.ok !== true };
				},
			}),
		);
	};
}
