// The verifier's calls to an OpenAI-compatible llama-server: a free-form
// analysis, then one-token prefills of each score tag with top-logprobs.
// Pi's provider layer does not expose logprobs, so these go to the server
// directly.

import { Agent, fetch } from "undici";
import { analysisPart, buildPrompt, type Criterion, expectedScore, type TokenLogprob } from "./pairwise.ts";

// fetch's default dispatcher gives up waiting for response headers after 300 s,
// before our own AbortSignal; a long non-streamed analysis then fails as "fetch
// failed" (twice in nerd-meta 015). The AbortSignal below is the only limit.
// undici's own fetch, not the global one: Pi's interactive main() replaces
// globalThis.fetch with its undici 8, which rejects this undici 6 Agent with a
// bare "fetch failed" on every call (nerd-meta 033).
const noTimeouts = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export interface VerifierEndpoint {
	baseUrl: string; // e.g. http://127.0.0.1:18091/v1
	model: string;
	/** Cap on the analysis length; the verdict comes after it. */
	analysisTokens?: number;
	timeoutMs?: number;
}

export interface PairScore {
	ra: number;
	rb: number;
	analysisTokens: number;
	ms: number;
}

interface ChatResponse {
	choices: {
		message: { content?: string | null };
		logprobs?: { content?: { token: string; logprob: number; top_logprobs?: TokenLogprob[] }[] } | null;
	}[];
	usage?: { completion_tokens?: number };
}

async function chat(ep: VerifierEndpoint, body: Record<string, unknown>): Promise<ChatResponse> {
	const r = await fetch(`${ep.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: ep.model, ...body }),
		signal: AbortSignal.timeout(ep.timeoutMs ?? 600_000),
		dispatcher: noTimeouts,
	});
	if (!r.ok) throw new Error(`verifier call: HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
	return (await r.json()) as ChatResponse;
}

/** Rewards (Ra, Rb) in [0, 1] for candidate a in slot A and b in slot B. Throws rather than guessing. */
export async function scorePair(
	ep: VerifierEndpoint,
	task: string,
	a: string,
	b: string,
	criterion: Criterion,
): Promise<PairScore> {
	const t0 = Date.now();
	const user = { role: "user", content: buildPrompt(task, a, b, criterion) };
	const noThinking = { chat_template_kwargs: { enable_thinking: false } };

	const analysis = await chat(ep, {
		messages: [user],
		max_tokens: ep.analysisTokens ?? 768,
		temperature: 1.0,
		...noThinking,
	});
	let prefix = analysisPart(analysis.choices[0]?.message.content ?? "");

	const scores: number[] = [];
	for (const tag of ["<score_A>", "<score_B>"]) {
		prefix += `\n${tag}`;
		const r = await chat(ep, {
			messages: [user, { role: "assistant", content: prefix }],
			max_tokens: 1,
			temperature: 1.0,
			logprobs: true,
			top_logprobs: 20,
			...noThinking,
		});
		const pos = r.choices[0]?.logprobs?.content?.[0];
		const score = pos?.top_logprobs ? expectedScore(pos.top_logprobs) : undefined;
		if (score === undefined) {
			throw new Error(`verifier: no score letter among top logprobs after ${tag} (got ${JSON.stringify(pos)})`);
		}
		scores.push(score);
		prefix += ` ${pos?.token.trim()} </${tag.slice(1)}`;
	}
	return {
		ra: scores[0],
		rb: scores[1],
		analysisTokens: analysis.usage?.completion_tokens ?? 0,
		ms: Date.now() - t0,
	};
}
