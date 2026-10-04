// Check the task's own text clause by clause before the run is declared done
// (ticket 030). Ticket 015's failures were runs whose tests passed while the
// specification did not hold (a TypeError where a RangeError was asked for, a
// trailing "-", floating-point shares); a judge at forks did not see them.
//
// After the agent's first "done", the harness sends one more user turn: the
// task text again, with the order to list its clauses, write an executable
// check for each, run them, and report a verdict line. A round that found
// failures (or gave no readable verdict) is followed by another, up to a bound,
// so a fix is itself checked. Nothing here knows the model or the task.

// Loose on purpose: in ticket 030 the model often copied the placeholder's
// words ("0 checks that failed on the first run in this reply"), and a strict
// pattern read that as no verdict and spent two more rounds.
export const VERDICT_RE = /SPEC CHECK:\s*\**\s*(\d+)\s+clauses?\D*?(\d+)\b[^\n]*?failed/i;

export interface Verdict {
	clauses: number;
	failed: number;
}

/** The last verdict line in the reply, if any. */
export function parseVerdict(text: string): Verdict | undefined {
	let found: Verdict | undefined;
	for (const line of text.split("\n")) {
		const m = VERDICT_RE.exec(line);
		if (m) found = { clauses: Number(m[1]), failed: Number(m[2]) };
	}
	return found;
}

export function specCheckPrompt(task: string, round: number): string {
	const again =
		round > 1
			? "This is a re-check after your fixes: write or update the checks and run all of them again from the start.\n\n"
			: "";
	return `Before this task counts as done, check your work against the task text itself, not against the existing tests alone.
${again}The task as you were given it:
<<<
${task}
>>>

1. List every requirement in that text as a numbered clause: each rule, each example input with its expected result, each error case with its exact error type. Quote the text of the clause.
2. For every clause write a concrete executable check: an assertion in a script that calls the code with that input and compares with what the text says. Reading the code is not a check. Put the checks in a new file the task does not forbid you to create, and run it.
3. Read the output. For every check that failed, say which clause it was, then fix the code (not the check, unless the check misread the text) and rerun until all checks and the project's own tests pass.

End your reply with exactly one line of the form "SPEC CHECK: <clauses> clauses, <failed> failed", where <failed> counts the checks that failed on their first run in this reply. For example:
SPEC CHECK: 12 clauses, 0 failed`;
}

export interface SpecCheckSession {
	prompt(text: string): Promise<void>;
	readonly messages: readonly unknown[];
}

export interface RoundRecord {
	round: number;
	verdict?: Verdict;
	stopReason?: string;
}

function lastAssistant(messages: readonly unknown[]): { text: string; stopReason?: string } | undefined {
	const m = messages.at(-1) as
		| { role?: string; stopReason?: string; content?: string | { type: string; text?: string }[] }
		| undefined;
	if (m?.role !== "assistant") return undefined;
	const text =
		typeof m.content === "string"
			? m.content
			: (m.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
	return { text, stopReason: m.stopReason };
}

/**
 * Run spec-check rounds until one reports no failures, or maxRounds is spent,
 * or a round does not end cleanly (the caller's done-check then reports it).
 */
export async function runSpecCheck(
	session: SpecCheckSession,
	task: string,
	opts: { maxRounds: number; onRound?: (r: RoundRecord) => void },
): Promise<RoundRecord[]> {
	const rounds: RoundRecord[] = [];
	for (let round = 1; round <= opts.maxRounds; round++) {
		await session.prompt(specCheckPrompt(task, round));
		const last = lastAssistant(session.messages);
		const rec: RoundRecord = {
			round,
			verdict: last ? parseVerdict(last.text) : undefined,
			stopReason: last?.stopReason,
		};
		rounds.push(rec);
		opts.onRound?.(rec);
		if (last?.stopReason !== "stop") break;
		if (rec.verdict && rec.verdict.failed === 0) break;
	}
	return rounds;
}
