// Pairwise fine-grained reward, ported from llm-as-a-verifier
// (llm_verifier/fine_grained_reward.py, commit 8db8a11).
//
// The verifier writes a short analysis of two candidates, then the scorer
// prefills "<score_A>" (and "<score_B>") after that analysis and reads the
// model's probability distribution over the 20 score letters A..T at that one
// position. The reward is the expectation over that distribution, in [0, 1]:
// a sharp "A" is 1, a sharp "T" is 0, and uncertainty lands in between.
//
// Measured against llama-server (ticket 008): prefilling a trailing assistant
// message works, top_logprobs=20 is returned, and grammar does not change the
// reported probabilities, so none is sent.

export const GRANULARITY = 20;
export const LETTERS = Array.from({ length: GRANULARITY }, (_, i) => String.fromCharCode(65 + i));

export const SCALE_DESCRIPTION = `Rate how likely the agent correctly solved the task on a 20-point scale using letters A through T:
  A = clearly and completely succeeded with verified output (best)
  B-D = succeeded with only minor issues
  E-G = above average, mostly correct with some issues
  H-J = uncertain, leans toward success
  K-M = uncertain, leans toward failure
  N-P = below average, significant issues remain
  Q-S = failed with some partial progress
  T = clearly and completely failed (worst)`;

export interface Criterion {
	name: string;
	description: string;
}

/** A top-logprobs entry at one position: token text and natural-log probability. */
export interface TokenLogprob {
	token: string;
	logprob: number;
}

/**
 * Expected score in [0, 1] from the top-logprobs at the score position, or
 * undefined when no scale letter is among them (the caller must not turn that
 * into a silent 0.5: that is how a broken setup hides, see decision 0005).
 */
export function expectedScore(alternatives: TokenLogprob[]): number | undefined {
	const probs = new Map<number, number>();
	for (const { token, logprob } of alternatives) {
		let t = token.trim();
		if (t.startsWith(">")) t = t.slice(1).trim();
		if (t.length !== 1) continue;
		const i = LETTERS.indexOf(t.toUpperCase());
		if (i < 0) continue;
		const value = GRANULARITY - i; // A = 20 ... T = 1
		// Several spellings (" A", "A", "a") of one letter: keep the largest,
		// as the Python original does.
		probs.set(value, Math.max(probs.get(value) ?? 0, Math.exp(logprob)));
	}
	if (probs.size === 0) return undefined;
	let total = 0;
	let weighted = 0;
	for (const [v, p] of probs) {
		total += p;
		weighted += v * p;
	}
	return (weighted / total - 1) / (GRANULARITY - 1);
}

/**
 * One pairwise prompt focused on one criterion. Everything but the criterion
 * comes first, so prompts for different criteria and repeats share a prefix
 * that llama-server's prompt cache can reuse.
 */
export function buildPrompt(task: string, a: string, b: string, criterion: Criterion, note = ""): string {
	return [
		"You are an expert evaluator of AI coding agents. You will see a task description and two candidate " +
			"next steps of an agent, then evaluate them on ONE specific criterion, stated at the end.",
		note,
		`**Task and history so far:**\n${task}`,
		`**Candidate A:**\n${a}`,
		`**Candidate B:**\n${b}`,
		`**Rating Scale:**\n${SCALE_DESCRIPTION}`,
		`**Evaluation Guideline — ${criterion.name}:**\n${criterion.description}`,
		`Score each candidate ONLY on this specific criterion ("${criterion.name}"). Ignore other aspects.`,
		"Reason it through briefly first, then END your reply with exactly these two lines and nothing after " +
			"them. Replace each placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n" +
			"<score_A> LETTER_A_TO_T </score_A>\n<score_B> LETTER_A_TO_T </score_B>",
		"Begin your analysis now.",
	]
		.filter((s) => s !== "")
		.join("\n\n");
}

/** The analysis part of a reply: everything before the first score tag the model wrote itself. */
export function analysisPart(text: string): string {
	const cut = ["<score_A>", "<score_B>"].map((t) => text.indexOf(t)).filter((i) => i >= 0);
	return (cut.length ? text.slice(0, Math.min(...cut)) : text).trimEnd();
}
