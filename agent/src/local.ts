// What the headless run (run.ts) and the interactive TUI (tui.ts) share: the
// local llama-server as a Pi model, the system prompt, the compaction settings
// for its window, and the verifier wired as a stream function.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RetrySettings } from "@earendil-works/pi-coding-agent";
import { leadingSystemPromptIs, verifierStreamFn } from "./verifier/stream.ts";

// Pi phones home by default (install telemetry, catalog refresh, version
// check). The agent must reach the network only where its task sends it.
export function stayOffline() {
	process.env.PI_OFFLINE = "1";
	process.env.PI_TELEMETRY = "0";
	process.env.PI_SKIP_VERSION_CHECK = "1";
}

// The method lines (ticket 043) come from a stage-by-stage review of the first
// acceptance run and the four runs of ticket 038: whole working files
// rewritten again and again, checks typed once and lost, a surprising result
// blamed on the tool (or "solved" by repeating the call), a remark answered
// with a rewrite, and "verified and working" with nothing behind it. They
// replace the two lines on small steps and trusting output. The tools line
// named four tools, while the plan turn has no bash and the work has the web
// tools too (prompt audit, ticket 059): the tools come with their own
// descriptions, so the line only says where the work is.
export const SYSTEM_PROMPT = `You are a software engineer working alone in a Linux container.
The working directory is the project.
A language the image lacks: \`nerd-get go|rust|uv\` installs it in your home, which survives restarts (npm -g and uv tools go there too).
Method:
- Small steps: change one thing (edit a working file, do not rewrite it), run it, read the output.
- Keep each check as a script or test in the project and rerun all of them after later changes.
- When output surprises you, suspect your own code before the tool. If a step fails twice the same way, change approach.
- For a remark, reproduce it first, then make the smallest change that fixes it.
- Report what you ran and what it showed, and what you did not check.
When the task is done and verified, reply with a short summary and stop.`;

// The web tools' own guidance (their promptSnippet/promptGuidelines) never
// reaches the model: Pi builds those lines only when no system prompt of our
// own is set, and both modes set one (prompt audit, ticket 059; the notes/
// rule was in none of the three acceptance runs' requests). What matters of it
// is said here, and the harness keeps the fetched pages itself (web-notes.ts).
export const WEB_PROMPT = `Facts from outside your knowledge (rules of a game, a format, a library's API): web_search, then web_fetch a result and work from what the page says; a long page is cut, the rest is in the file named at its end.
Rules you took from the web, show to the user (in the README or on the page) as the source states them, with its URL.`;

// Process ticket 090, stage 3 (operator, 2026-10-17): 11-32% of Bonsai's thinking in the tax
// runs was arithmetic done by hand — 20-30 minutes of long multiplication in one reply, with the
// shell at hand — and its hand-made expected values were wrong more than once. NERD_CALC=1:
// this rule, and the guard that cuts a reply computing by hand (calc-guard.ts).
export const CALC_PROMPT =
	"Every calculation, even 1+2, is done by a program you write and run (python3, or the project's language: `node -e`, `nerd-rs-eval`), never in your head or in your reasoning. Expected values for checks are computed by a program written from the task's text, not from your code.";

export function calcOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_CALC === "1";
}

/** The system prompt: SYSTEM_PROMPT, WEB_PROMPT when the web tools are on, CALC_PROMPT with NERD_CALC=1. */
export function systemPrompt(web: boolean, calc = calcOn()): string {
	return [SYSTEM_PROMPT, web ? WEB_PROMPT : "", calc ? CALC_PROMPT : ""].filter(Boolean).join("\n");
}

/** Appended in the interactive mode, where a person is on the other end. */
export function operatorPrompt(appPort = process.env.NERD_APP_PORT, operatorUrl = process.env.NERD_OPERATOR_URL): string {
	const app = appPort
		? // "served on port 8000" alone made the model hard-code 8000, and the done
			// gate, which starts the app on a free port, failed on it twice in 0006g.
			` Anything meant to be opened in the operator's browser is served on port ${appPort}: listen on \`process.env.PORT || ${appPort}\`.`
		: "";
	// The name under which the operator sees this machine cannot be found from
	// inside the container (nobody guessed it in the A/B of 2026-10-03), so it
	// is given as a fact: NERD_OPERATOR_URL.
	const url = operatorUrl ? ` The operator reaches the app at ${operatorUrl}.` : "";
	// Questions and the plan file at the start of a task are the harness's
	// step since ticket 043 (plan-step.ts): asked for here (038), the model
	// never asked before coding. What stays is git, the README, and checking
	// from where the operator stands.
	return `An operator talks to you in this session. Work in git and commit each step that works; a project meant for others has a README saying how to run it and how to check it. A remark from the operator takes priority over your plan.${app}${url} The command \`browse <url>\` opens a page in a headless browser as a user would and prints its errors and visible text (\`browse --help\`: clicks, typing, screenshots). Before you tell the operator that something works, check it the way they will use it: in a fresh command, at the address they use, from a clean checkout.`;
}

export const TOOLS = ["read", "bash", "edit", "write"];

export type Thinking = "off" | "low" | "medium" | "high";

/**
 * What serves the model: llama-server (in its container, or on the host),
 * mlx-vlm's server (NERD_LLAMA=mlx on macOS, tools/mlx-host.sh), or Ollama
 * (a model server on another machine, ticket 099), or a cloud provider behind
 * the key proxy (NERD_LLAMA=provider, keyproxy.ts).
 */
export type Server = "llama" | "mlx" | "ollama" | "provider";

export interface LocalModel {
	baseUrl: string;
	id: string;
	ctx: number;
	thinking: Thinking;
	verifyN: number;
	server?: Server;
	/** The longest reply the provider allows; a local server's is the window. */
	maxOut?: number;
	/** The provider's host, as the key proxy names it (NERD_LLAMA=provider). */
	provider?: string;
}

async function servedModelId(baseUrl: string): Promise<string> {
	const r = await fetch(`${baseUrl}/models`);
	const body = (await r.json()) as { data: { id: string }[] };
	return body.data[0].id;
}

/**
 * The model mlx-vlm's server has loaded, from its /health (llama-server's
 * /health has no such field). Its /v1/models also lists every model in the
 * Hugging Face cache, sorted by name, so the first entry need not be the one
 * it serves, and a request naming another model makes it load that one.
 */
export async function mlxLoadedModel(baseUrl: string): Promise<string | undefined> {
	try {
		const r = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/health`);
		const body = (await r.json()) as { loaded_model?: unknown };
		return typeof body.loaded_model === "string" && body.loaded_model ? body.loaded_model : undefined;
	} catch {
		return undefined;
	}
}

/** The context size the server actually runs with (llama-server /props), so Pi's budget cannot drift from it. */
async function servedContext(baseUrl: string): Promise<number | undefined> {
	try {
		const r = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/props`);
		const body = (await r.json()) as { default_generation_settings?: { n_ctx?: number } };
		return body.default_generation_settings?.n_ctx;
	} catch {
		return undefined;
	}
}

/** Whether Ollama serves at baseUrl: its /api/version answers {"version": ...}; llama-server's is a 404. */
export async function isOllama(baseUrl: string): Promise<boolean> {
	try {
		const r = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/api/version`);
		if (!r.ok) return false;
		const body = (await r.json()) as { version?: unknown };
		return typeof body.version === "string";
	} catch {
		return false;
	}
}

/**
 * The window Ollama runs a model with. Its OpenAI endpoint cannot set one per
 * request, so it is the server's: /api/ps has it while the model is loaded;
 * otherwise the model's own maximum from /api/show, which Ollama uses when
 * memory allows and OLLAMA_CONTEXT_LENGTH does not cap it (NERD_CTX overrides).
 */
async function ollamaContext(baseUrl: string, model: string): Promise<number | undefined> {
	const root = baseUrl.replace(/\/v1\/?$/, "");
	try {
		const ps = (await (await fetch(`${root}/api/ps`)).json()) as { models?: { name?: string; context_length?: number }[] };
		const loaded = ps.models?.find((m) => m.name === model)?.context_length;
		if (loaded) return loaded;
		const r = await fetch(`${root}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
		const show = (await r.json()) as { model_info?: Record<string, unknown> };
		const key = Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length"));
		const n = key ? show.model_info![key] : undefined;
		return typeof n === "number" ? n : undefined;
	} catch {
		return undefined;
	}
}

/** The provider's host if the key proxy answers at baseUrl (its /health is {"keyproxy": host}). */
export async function keyProxyHost(baseUrl: string): Promise<string | undefined> {
	try {
		const r = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/health`);
		const body = (await r.json()) as { keyproxy?: unknown };
		return typeof body.keyproxy === "string" ? body.keyproxy : undefined;
	} catch {
		return undefined;
	}
}

/** The API key the agent sends its model server: the key proxy's token (NERD_KEYPROXY_AUTH=on, set by ./UP), else none. */
export function modelApiKey(): string {
	return process.env.NERD_MODEL_API_KEY || "none";
}

// A provider's reply limit when its model list does not give one: a common
// floor among OpenAI-compatible APIs, which refuse max_tokens above their own.
const PROVIDER_MAX_OUT = 8192;

/**
 * The window and reply limit of a provider's model, from its /v1/models where
 * it says (OpenRouter: context_length, top_provider.max_completion_tokens).
 */
async function providerLimits(baseUrl: string, model: string): Promise<{ ctx?: number; maxOut?: number }> {
	try {
		const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${modelApiKey()}` } });
		const body = (await r.json()) as { data?: { id?: string; context_length?: unknown; top_provider?: { max_completion_tokens?: unknown } }[] };
		const m = body.data?.find((x) => x.id === model);
		const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
		return { ctx: num(m?.context_length), maxOut: num(m?.top_provider?.max_completion_tokens) };
	} catch {
		return {};
	}
}

/** The model as the environment and the running server describe it (NERD_* variables, see run.ts). */
export async function localModel(): Promise<LocalModel> {
	const baseUrl = process.env.NERD_BASE_URL ?? "http://127.0.0.1:18091/v1";
	const provider = await keyProxyHost(baseUrl);
	if (provider) {
		const id = process.env.NERD_MODEL;
		if (!id) throw new Error(`NERD_MODEL is not set: name the model of ${provider} to use`);
		const lim = await providerLimits(baseUrl, id);
		const ctx = Number(process.env.NERD_CTX || lim.ctx || 0);
		if (!ctx) throw new Error(`NERD_CTX is not set and ${provider} does not give ${id}'s window: set it`);
		return {
			baseUrl,
			ctx,
			// The provider's own thinking defaults; nerd's switch is for local servers.
			thinking: "off",
			id,
			// The verifier needs logprobs and a prefilled reply, which providers lack (0018).
			verifyN: 1,
			server: "provider",
			maxOut: Math.min(ctx, lim.maxOut ?? PROVIDER_MAX_OUT),
			provider,
		};
	}
	if (await isOllama(baseUrl)) {
		// Ollama's /v1/models lists every model it has, and a request names the
		// one it loads: the model is the operator's choice, not the first entry.
		const id = process.env.NERD_MODEL;
		if (!id) throw new Error(`NERD_MODEL is not set: Ollama at ${baseUrl} serves many models, name one (ollama list)`);
		return {
			baseUrl,
			ctx: Number(process.env.NERD_CTX || (await ollamaContext(baseUrl, id)) || 16384),
			thinking: (process.env.NERD_THINKING ?? "off") as Thinking,
			id,
			verifyN: Number(process.env.NERD_VERIFY_N ?? 1),
			server: "ollama",
		};
	}
	const mlx = await mlxLoadedModel(baseUrl);
	return {
		baseUrl,
		// mlx-vlm has no fixed context (its cache grows): ./UP passes NERD_CTX.
		ctx: Number(process.env.NERD_CTX || (mlx ? undefined : await servedContext(baseUrl)) || 16384),
		thinking: (process.env.NERD_THINKING ?? "off") as Thinking,
		id: process.env.NERD_MODEL || mlx || (await servedModelId(baseUrl)),
		verifyN: Number(process.env.NERD_VERIFY_N ?? 1),
		server: mlx ? "mlx" : "llama",
	};
}

/**
 * The planner of the ping-pong pair (pair.ts), from NERD_PLAN_BASE_URL and
 * NERD_PLAN_MODEL; undefined without it. A llama-server: its window from /props.
 */
export async function plannerModel(env: Record<string, string | undefined> = process.env): Promise<LocalModel | undefined> {
	const baseUrl = env.NERD_PLAN_BASE_URL;
	if (!baseUrl) return undefined;
	return {
		baseUrl,
		ctx: Number((await servedContext(baseUrl)) || 16384),
		thinking: (env.NERD_THINKING ?? "off") as Thinking,
		id: env.NERD_PLAN_MODEL || (await servedModelId(baseUrl)),
		verifyN: 1,
		server: "llama",
	};
}

/** Pi's model definition of the local server (models.json entry or registerProvider model). */
export function modelDefinition(m: LocalModel) {
	if (m.server === "provider")
		return {
			id: m.id,
			name: m.id,
			contextWindow: m.ctx,
			maxTokens: m.maxOut ?? m.ctx,
			// Not declared: Pi then sends no thinking fields, which each provider
			// spells its own way, and the model thinks as its provider defaults.
			reasoning: false,
			thinkingLevelMap: undefined,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				supportsStrictMode: false,
				// OpenAI's own API refuses max_tokens for its newer models ("Use
				// 'max_completion_tokens' instead", gpt-5.4-nano, 2026-10-29); others
				// that speak its dialect mostly know only max_tokens.
				maxTokensField: m.provider === "api.openai.com" ? ("max_completion_tokens" as const) : ("max_tokens" as const),
				// Unused without reasoning; declared so both definitions have one shape.
				thinkingFormat: "openai" as const,
			},
		};
	return {
		id: m.id,
		name: m.id,
		contextWindow: m.ctx,
		// The whole window, as Pi's own llama.cpp extension declares it: Pi clamps
		// each request to what is left of the window (clampMaxTokensToContext).
		// A fixed 16K would cut thinking replies (ticket 077). The summary stays
		// bounded by 0.8 * reserveTokens (settingsFor), now always the tighter cap.
		maxTokens: m.ctx,
		// Always declared: Pi sends chat_template_kwargs.enable_thinking only
		// for a reasoning model with a thinking format, and Bonsai 2's template
		// thinks by default. Without this, "off" still thought on every step
		// and the summariser hit its token cap (ticket 011).
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Ollama ignores chat_template_kwargs and thinks by default; only
		// reasoning_effort "none" turns it off (measured 2026-10-29, Ollama
		// 0.40.12, qwen3.6: 1531 thinking tokens with the kwargs, none with it).
		...(m.server === "ollama" ? { thinkingLevelMap: { off: "none" } } : {}),
		// The same compat set Pi's own llama.cpp extension uses.
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: m.server === "ollama",
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens" as const,
			// mlx-vlm's server ignores chat_template_kwargs and reads a top-level
			// enable_thinking, which is what Pi sends for "qwen".
			thinkingFormat:
				m.server === "ollama"
					? ("openai" as const)
					: m.server === "mlx"
						? ("qwen" as const)
						: ("qwen-chat-template" as const),
		},
	};
}

/**
 * Pi's compaction for our window. Pi compacts when the context passes
 * ctx - reserveTokens, keeps the last keepRecentTokens verbatim, and caps the
 * summary at min(0.8 * reserveTokens, model maxTokens); a summary that hits
 * the cap is thrown away, compaction fails, and once the window is full Pi
 * stops ("Context overflow recovery failed"). Pi merges each summary into the
 * next, so summaries grow over a long run: in the first acceptance run (32K,
 * 39 compactions in 4 h 48 min) they grew from 0.7K to 6.5K tokens against a
 * cap of 6.5K, then failed until the stop. At 64K: reserve 20K (cap 16K, 2.5x
 * the largest seen), keep 16K; compaction starts at 44K, and a typical 6K
 * summary plus the kept 16K leaves about 20K of new work between compactions,
 * four times the ~5K of the 32K run.
 *
 * With pi-vcc (packages.ts, on by default) only the threshold here still
 * applies: pi-vcc writes the summary without the model (bounded, ~1-2K tokens
 * of transcript plus sections) and keeps its own tail (the last user turn,
 * or the last ~25K tokens when that turn is the whole task).
 */
/** NERD_RETRIES: retries of a failed model request (default 8, about 2.5 min of backoff). */
export function retries(env: Record<string, string | undefined> = process.env): number {
	const n = Number(env.NERD_RETRIES);
	return env.NERD_RETRIES && Number.isInteger(n) && n >= 0 ? n : 8;
}

// Process ticket 110: a cloud provider (free models through a gateway) breaks a streamed
// reply off with finish_reason "error" after HTTP 200; Pi reports "Provider finish_reason:
// error", which is not among the errors it retries, so one such break ended the run — 5 runs
// of 6 of one model on the bench of process ticket 106, after 2 to 12 minutes.
const PROVIDER_BREAK = /\bfinish_reason:\s*error\b/i;

/** A reply the provider broke off with finish_reason "error": worth the same retries as a 5xx. */
export function providerBreak(m: { stopReason?: string; errorMessage?: string }): boolean {
	return m.stopReason === "error" && PROVIDER_BREAK.test(m.errorMessage ?? "");
}

/**
 * Pi retries a failed reply when AgentSession's `_isRetryableError` says so (both of its
 * call sites go through `this`); this session's also says so for a provider break. False
 * when this Pi has no such method (a test pins it on the class: a bump must look again).
 */
export function widenRetry(session: object): boolean {
	const s = session as { _isRetryableError?: (m: { stopReason?: string; errorMessage?: string }) => boolean };
	if (typeof s._isRetryableError !== "function") return false;
	const own = s._isRetryableError.bind(session);
	s._isRetryableError = (m) => own(m) || providerBreak(m);
	return true;
}

export function settingsFor(m: LocalModel) {
	return {
		compaction: {
			enabled: true,
			reserveTokens: Math.floor((m.ctx * 5) / 16),
			keepRecentTokens: Math.floor(m.ctx / 4),
		},
		// A model server on another machine drops off with the network: 2 retries
		// (6 s) ended a task on a 40 s outage (ticket 099); NERD_RETRIES, backoff to 30 s.
		retry: { enabled: true, maxRetries: retries(), baseDelayMs: 2000, maxAgentDelayMs: 30_000 } as RetrySettings,
		enableInstallTelemetry: false,
	};
}

/**
 * Best-of-N with the verifier (decisions 0005, 0007) around a base stream
 * function; N <= 1 returns the base unchanged.
 */
export function withVerifier(base: StreamFn, m: LocalModel, logPath?: string): StreamFn {
	return verifierStreamFn(base, {
		n: m.verifyN,
		baseUrl: m.baseUrl,
		model: m.id,
		ollama: m.server === "ollama",
		historyChars: Math.floor(m.ctx * 1.2), // ~0.3 of the window, at ~4 chars a token
		logPath,
		isAgentStep: leadingSystemPromptIs(SYSTEM_PROMPT.slice(0, 60)),
	});
}
