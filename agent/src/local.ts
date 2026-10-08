// What the headless run (run.ts) and the interactive TUI (tui.ts) share: the
// local llama-server as a Pi model, the system prompt, the compaction settings
// for its window, and the verifier wired as a stream function.

import type { StreamFn } from "@earendil-works/pi-agent-core";
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
// replace the two lines on small steps and trusting output.
export const SYSTEM_PROMPT = `You are a software engineer working alone in a Linux container.
Tools: read, bash, edit, write. The working directory is the project.
A language the image lacks: \`nerd-get go|rust|uv\` installs it in your home, which survives restarts (npm -g and uv tools go there too).
Method:
- Small steps: change one thing (edit a working file, do not rewrite it), run it, read the output.
- Keep each check as a script or test in the project and rerun all of them after later changes.
- When output surprises you, suspect your own code before the tool. If a step fails twice the same way, change approach.
- For a remark, reproduce it first, then make the smallest change that fixes it.
- Report what you ran and what it showed, and what you did not check.
When the task is done and verified, reply with a short summary and stop.`;

/** Appended in the interactive mode, where a person is on the other end. */
export function operatorPrompt(appPort = process.env.NERD_APP_PORT, operatorUrl = process.env.NERD_OPERATOR_URL): string {
	const app = appPort
		? ` Anything meant to be opened in the operator's browser is served on port ${appPort}.`
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
 * What serves the model: llama-server (in its container, or on the host), or
 * mlx-vlm's server (NERD_LLAMA=mlx on macOS, tools/mlx-host.sh).
 */
export type Server = "llama" | "mlx";

export interface LocalModel {
	baseUrl: string;
	id: string;
	ctx: number;
	thinking: Thinking;
	verifyN: number;
	server?: Server;
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

/** The model as the environment and the running server describe it (NERD_* variables, see run.ts). */
export async function localModel(): Promise<LocalModel> {
	const baseUrl = process.env.NERD_BASE_URL ?? "http://127.0.0.1:18091/v1";
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

/** Pi's model definition of the local server (models.json entry or registerProvider model). */
export function modelDefinition(m: LocalModel) {
	return {
		id: m.id,
		name: m.id,
		contextWindow: m.ctx,
		// Also bounds the summary (settingsFor): at least 0.8 * reserveTokens
		// (a quarter of the window), so it is never the tighter of the two caps.
		maxTokens: Math.max(8192, Math.min(16384, Math.floor(m.ctx / 4))),
		// Always declared: Pi sends chat_template_kwargs.enable_thinking only
		// for a reasoning model with a thinking format, and Bonsai 2's template
		// thinks by default. Without this, "off" still thought on every step
		// and the summariser hit its token cap (ticket 011).
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// The same compat set Pi's own llama.cpp extension uses.
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens" as const,
			// mlx-vlm's server ignores chat_template_kwargs and reads a top-level
			// enable_thinking, which is what Pi sends for "qwen".
			thinkingFormat: m.server === "mlx" ? ("qwen" as const) : ("qwen-chat-template" as const),
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
export function settingsFor(m: LocalModel) {
	return {
		compaction: {
			enabled: true,
			reserveTokens: Math.floor((m.ctx * 5) / 16),
			keepRecentTokens: Math.floor(m.ctx / 4),
		},
		retry: { enabled: true, maxRetries: 2 },
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
		historyChars: Math.floor(m.ctx * 1.2), // ~0.3 of the window, at ~4 chars a token
		logPath,
		isAgentStep: leadingSystemPromptIs(SYSTEM_PROMPT.slice(0, 60)),
	});
}
