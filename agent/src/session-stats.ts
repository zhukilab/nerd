// Session statistics (#993): what a session of nerd costs and how close it is to its limits —
// tokens, the context now and at its peak, the model server's own time and speed (its `timings`),
// MTP draft acceptance, time in tools. One accumulator per agent process, fed by the extension
// below in the TUI and headless alike; read by the TUI's status line, the agora channel's
// `context` event (agora-channel.ts) and the headless run's `session_summary` line (run.ts).
//
// The field names were agreed with agora's collector (#983, letters of 2026-11-21): the collector
// reads our files and maps our names; `v` on every new record kind, `ts` in UTC ISO-8601, units in
// the names where they are not tokens.
//
// llama-server's `timings` come in the last chunk of a streamed reply (Pi drops them; the raw chunk
// reaches extensions as `provider_stream_event`): prompt_n/_ms, predicted_n/_ms, cache_n, and with a
// draft model or MTP draft_n/draft_n_accepted. A server without them (Ollama, a cloud API) leaves
// the model's time and speed unknown — null, not 0.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUMMARY_VERSION = 1;

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
type Timings = { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; cache_n?: number; draft_n?: number; draft_n_accepted?: number };

export class SessionStats {
	readonly startedMs: number;
	session?: string;
	model?: string;
	server?: string;
	messages = 0;
	tokens = { in: 0, out: 0, cache_read: 0, cache_write: 0 };
	ctx = { now: 0, peak: 0, window: 0 };
	timed = { replies: 0, prompt_n: 0, prompt_ms: 0, predicted_n: 0, predicted_ms: 0, cache_n: 0, draft_n: 0, draft_accepted: 0 };
	last?: { tps_gen?: number; mtp_accept?: number };
	toolMs = 0;
	compactions = 0;
	ralphRounds = 0;
	private toolsOpen = new Map<string, number>();
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.startedMs = now();
	}

	/** An assistant reply ended: its usage (Pi's message_end). */
	reply(usage: Usage | undefined) {
		this.messages++;
		if (!usage) return;
		this.tokens.in += usage.input ?? 0;
		this.tokens.out += usage.output ?? 0;
		this.tokens.cache_read += usage.cacheRead ?? 0;
		this.tokens.cache_write += usage.cacheWrite ?? 0;
	}

	/** The context as Pi counts it now. */
	context(tokens: number | null | undefined, window: number | undefined) {
		if (typeof tokens === "number") {
			this.ctx.now = tokens;
			this.ctx.peak = Math.max(this.ctx.peak, tokens);
		}
		if (window) this.ctx.window = window;
	}

	/** A raw stream chunk; only its `timings` count (the last chunk of a llama-server reply). */
	chunk(data: unknown) {
		const t = (data as { timings?: Timings } | null)?.timings;
		if (!t || typeof t !== "object") return;
		const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
		this.timed.replies++;
		this.timed.prompt_n += n(t.prompt_n);
		this.timed.prompt_ms += n(t.prompt_ms);
		this.timed.predicted_n += n(t.predicted_n);
		this.timed.predicted_ms += n(t.predicted_ms);
		this.timed.cache_n += n(t.cache_n);
		this.timed.draft_n += n(t.draft_n);
		this.timed.draft_accepted += n(t.draft_n_accepted);
		this.last = {
			tps_gen: n(t.predicted_ms) > 0 ? round1((n(t.predicted_n) * 1000) / n(t.predicted_ms)) : undefined,
			mtp_accept: n(t.draft_n) > 0 ? round3(n(t.draft_n_accepted) / n(t.draft_n)) : undefined,
		};
	}

	toolStart(id: string) {
		this.toolsOpen.set(id, this.now());
	}

	toolEnd(id: string) {
		const t = this.toolsOpen.get(id);
		if (t === undefined) return;
		this.toolsOpen.delete(id);
		this.toolMs += this.now() - t;
	}

	uptimeS(): number {
		return Math.round((this.now() - this.startedMs) / 1000);
	}

	/** Draft acceptance over the session, or null when the server reported no drafts. */
	mtpAccept(): number | null {
		return this.timed.draft_n > 0 ? round3(this.timed.draft_accepted / this.timed.draft_n) : null;
	}

	/** The agora channel's `context` event, extended (PI-CHANNEL `context` + #993). */
	contextEvent(): Record<string, unknown> {
		return { peak: this.ctx.peak, tps_gen: this.last?.tps_gen ?? null, mtp_accept: this.last?.mtp_accept ?? null, uptime_s: this.uptimeS() };
	}

	/** The status line: `ctx 41K/256K 16% (peak 198K) · 22 t/s · MTP 71% · 2h10m`. */
	statusLine(): string {
		const parts: string[] = [];
		if (this.ctx.window) {
			const pct = Math.round((100 * this.ctx.now) / this.ctx.window);
			parts.push(`ctx ${k(this.ctx.now)}/${k(this.ctx.window)} ${pct}%${this.ctx.peak > this.ctx.now ? ` (peak ${k(this.ctx.peak)})` : ""}`);
		}
		if (this.last?.tps_gen !== undefined) parts.push(`${Math.round(this.last.tps_gen)} t/s`);
		const mtp = this.mtpAccept();
		if (mtp !== null) parts.push(`MTP ${Math.round(mtp * 100)}%`);
		parts.push(duration(this.uptimeS()));
		return parts.join(" · ");
	}

	/** The session's one summary line for the run's events log (and agora's collector). */
	summary(complete: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
		const wallS = (this.now() - this.startedMs) / 1000;
		const hasTimings = this.timed.replies > 0;
		const promptS = this.timed.prompt_ms / 1000;
		const genS = this.timed.predicted_ms / 1000;
		const toolS = this.toolMs / 1000;
		const inputAll = this.tokens.in + this.tokens.cache_read;
		const serverIn = this.timed.prompt_n + this.timed.cache_n;
		// The server's own count first (llama-server: cache_n of its timings); Pi's cacheRead otherwise.
		const hitRatio = hasTimings && serverIn > 0 ? round3(this.timed.cache_n / serverIn) : inputAll > 0 ? round3(this.tokens.cache_read / inputAll) : null;
		return {
			type: "session_summary",
			v: SUMMARY_VERSION,
			ts: new Date(this.now()).toISOString(),
			complete,
			session: this.session ?? null,
			model: this.model ?? null,
			server: this.server ?? null,
			started: new Date(this.startedMs).toISOString(),
			wall_s: round1(wallS),
			messages: this.messages,
			tokens: {
				...this.tokens,
				// Pi's usage from llama-server has no cached tokens; the server's own cache_n counts them.
				server_cache_n: hasTimings ? this.timed.cache_n : null,
				hit_ratio: hitRatio,
			},
			ctx: { peak: this.ctx.peak, window: this.ctx.window || null },
			model_s: hasTimings ? { prompt: round1(promptS), gen: round1(genS) } : null,
			tool_s: round1(toolS),
			wait_s: hasTimings ? round1(Math.max(0, wallS - promptS - genS - toolS)) : null,
			tps: hasTimings
				? { prompt: promptS > 0 ? round1(this.timed.prompt_n / promptS) : null, gen: genS > 0 ? round1(this.timed.predicted_n / genS) : null }
				: null,
			mtp_accept: this.mtpAccept(),
			draft_n: hasTimings ? this.timed.draft_n : null,
			ralph_rounds: this.ralphRounds,
			compactions: this.compactions,
			...extra,
		};
	}
}

function round1(x: number): number {
	return Math.round(x * 10) / 10;
}
function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}
function k(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;
}
function duration(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

let current: SessionStats | undefined;

/** The process's accumulator (one agent per process); made on first use. */
export function sessionStats(): SessionStats {
	current ??= new SessionStats();
	return current;
}

/** For tests: start over. */
export function resetSessionStats(s?: SessionStats): SessionStats {
	current = s ?? new SessionStats();
	return current;
}

/**
 * The extension that feeds the accumulator from Pi's events; with an operator (TUI) it also keeps the
 * status line in the footer (`ctx.ui.setStatus`). A new session of the same process (Ralph's fresh
 * rounds) keeps counting into the same accumulator: the run's totals are what the summary is for.
 */
export function sessionStatsExtension(pi: ExtensionAPI, opts: { operator?: boolean } = {}) {
	const st = sessionStats();
	type Ctx = { getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined; ui?: { setStatus(key: string, text: string | undefined): void }; sessionManager?: { getSessionId(): string }; model?: { id?: string; baseUrl?: string } };
	const refresh = (ctx: Ctx | undefined) => {
		const u = ctx?.getContextUsage?.();
		if (u) st.context(u.tokens, u.contextWindow);
		if (opts.operator) ctx?.ui?.setStatus("nerd-stats", st.statusLine());
	};
	pi.on("session_start", (_e, ctx) => {
		const c = ctx as unknown as Ctx;
		st.session = c.sessionManager?.getSessionId() ?? st.session;
		st.model = c.model?.id ?? st.model;
		st.server = c.model?.baseUrl ?? st.server;
		refresh(c);
	});
	pi.on("provider_stream_event", (e) => {
		st.chunk((e as { data?: unknown }).data);
	});
	pi.on("message_end", (e, ctx) => {
		const m = (e as { message?: { role?: string; usage?: Usage } }).message;
		if (m?.role === "assistant") st.reply(m.usage);
		refresh(ctx as unknown as Ctx);
	});
	pi.on("tool_execution_start", (e) => st.toolStart((e as { toolCallId: string }).toolCallId));
	pi.on("tool_execution_end", (e) => st.toolEnd((e as { toolCallId: string }).toolCallId));
	pi.on("session_compact", (_e, ctx) => {
		st.compactions++;
		refresh(ctx as unknown as Ctx);
	});
	pi.on("turn_end", (_e, ctx) => refresh(ctx as unknown as Ctx));
}
