// The step log (process ticket 067, after superpowers executing-plans and @alexeiled/pi-plan-exec):
// a step of the plan is done when the harness has run its `check:` and it passed, not when the model
// says so. After each commit the model makes (a bash call with `git commit` that succeeded), the
// harness runs the checks of the steps not yet done — of the plan as committed (frozenPlan, as the
// Ralph loop does), in a clean clone of HEAD, with the Ralph loop's runner (runDoneWhen) — and adds
// to that call's result one note: which steps are done, and the first step not done with the end of
// its check's output. A step whose `check:` holds no command is not checked and holds nothing up; a
// step once done stays done (a regression is the done gate's and Ralph's to find). Each step that
// turns done, and each red report, is appended to the session as a "nerd-step" entry (step, command,
// exit code, commit): an append-only log. NERD_STEPS=1 turns it on (off until measured, ticket 067).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sh } from "./done-gate.ts";
import { type DoneItem, frozenPlan, type ItemResult, parseItem, runDoneWhen } from "./done-when.ts";

export const STEP_CHECK_MS = 120_000;

export function stepsOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_STEPS === "1";
}

export interface Step extends DoneItem {
	/** The step's number in the plan. */
	n: number;
}

/**
 * A step's check as a command whose exit code says it (plans write words after it): "… exits 0
 * with 15 passing tests" is the command; "… | wc -l returns 3", "… prints the board" expect an output
 * the exit code does not tell, so the step is not checked.
 */
export function runnable(cmd: string): string | undefined {
	const c = cmd.replace(/\s+(?:—\s*)?(?:exits?|exit code(?: is)?|returns? exit code)\s+0\b.*$/i, "").trim();
	// A command, not a file name, a call in the code's language or a word in backticks (seen in plans:
	// `test/discount.test.js`, `allocate(3,[0.3,0.1,0.2])`, `read lib/discount.js`, `ERROR`).
	if (!/^(?:!\s*)?(?:(?:[A-Z_][A-Z0-9_]*=\S+\s+)*)(?:node|npm|npx|test|\[|grep|git|sh|bash|curl|cargo|nerd-rs-eval|python3?|ls|diff|cmp|jq|deno|bun|\.\/)(?=[\s/]|$)/.test(c)) return undefined;
	// An inline program's flag without the program: the step names the command in words ("check: one-line
	// `node -e` import smoke-check of parse(…)"). Run, `node -e` exits 9 — 17 false red notes on the A/B of 067.
	if (/^(?:node|bun|deno|python3?|sh|bash)(?:\s+--input-type=\S+)?\s+(?:-e|--eval|-p|--print|-c)\s*$/.test(c) || /^(?:node|python3?|sh|bash|npx|cargo|nerd-rs-eval)\s*$/.test(c)) return undefined;
	if (/\s(?:returns?|prints?|shows?|outputs?|equals?|should|contains?)\s/i.test(c.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ""))) return undefined;
	return c || undefined;
}

/** The numbered items of a plan's Steps (or PLAN) section, each with the command of its `check:`, if any. */
export function planSteps(plan: string): Step[] {
	const lines = plan.split("\n");
	// PLAN.md's "## Steps" (its title is "# Plan"); a raw reply's "PLAN".
	let start = lines.findIndex((l) => /^#{1,3}\s*steps\s*$/i.test(l.trim()));
	if (start < 0) start = lines.findIndex((l) => /^PLAN\s*$/.test(l.trim()));
	if (start < 0) return [];
	const out: Step[] = [];
	for (const raw of lines.slice(start + 1)) {
		const l = raw.trim();
		if (/^#{1,3}\s/.test(l) || /^[A-Z][A-Z ]+$/.test(l)) break;
		const m = /^(\d+)[.)]\s+(.*)$/.exec(l);
		if (!m) continue;
		const { claim, cmd, after } = parseItem(m[2]);
		// "check: `npm test` exits non-zero" expects a failure (a baseline before the fix): its exit code
		// is the opposite of done, so the step is not checked (the A/B of 067, allocate's plan).
		const failing = /\b(non-?zero|fails?|failing|exits?\s+[1-9])\b/i.test(after);
		const c = cmd && !failing && runnable(cmd);
		out.push(c ? { n: Number(m[1]), claim, cmd: c } : { n: Number(m[1]), claim });
	}
	return out;
}

/** A bash command that makes a commit. */
export function commits(command: string): boolean {
	return /(^|[;&|(]\s*|\s)git\s+(?:-C\s+\S+\s+)?commit\b/.test(command);
}

function tail(why: string, n = 4): string {
	const lines = why.trim().split("\n");
	return lines.slice(-n).map((l) => `    ${l.trim()}`).join("\n");
}

/** The note added to the commit's result: the steps done, then the first one not done and why. */
export function stepNote(steps: Step[], done: Set<number>, red: ItemResult & { n: number } | undefined, commit: string): string {
	const checked = steps.filter((s) => s.cmd);
	const doneList = checked.filter((s) => done.has(s.n)).map((s) => s.n);
	const head = `[harness] Plan steps by their checks, run on commit ${commit.slice(0, 7)} in a clean clone: ${doneList.length} of ${checked.length} checked steps done${doneList.length ? ` (step${doneList.length > 1 ? "s" : ""} ${doneList.join(", ")})` : ""}`;
	const unchecked = steps.filter((s) => !s.cmd).map((s) => s.n);
	const un = unchecked.length ? `; step${unchecked.length > 1 ? "s" : ""} ${unchecked.join(", ")} ha${unchecked.length > 1 ? "ve" : "s"} no command to check` : "";
	if (!red) return `${head}${un}.`;
	return `${head}${un}. Step ${red.n} is not done: its check \`${red.cmd}\` ${red.why.split("\n")[0]}\n${tail(red.why.split("\n").slice(1).join("\n"))}`.trimEnd();
}

export function stepLog(pi: ExtensionAPI, opts: { timeoutMs?: number } = {}) {
	const done = new Set<number>();
	const unusable = new Set<number>();
	let plan: string | undefined;

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || event.isError) return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!commits(command)) return;
		const cwd = ctx.cwd || process.cwd();
		plan ??= await frozenPlan(cwd);
		if (!plan) return;
		const steps = planSteps(plan).map((s) => (unusable.has(s.n) ? { n: s.n, claim: s.claim } : s));
		const pending = steps.filter((s) => s.cmd && !done.has(s.n));
		if (!steps.some((s) => s.cmd)) return;
		const head = (await sh("git", ["rev-parse", "HEAD"], cwd, 30_000)).out.trim();
		const results = pending.length ? await runDoneWhen(cwd, pending, opts.timeoutMs ?? STEP_CHECK_MS) : [];
		let red: (ItemResult & { n: number }) | undefined;
		results.forEach((r, k) => {
			const n = pending[k].n;
			// A check the runner cannot use (cannot fail, does not parse) checks nothing: the step is unchecked.
			if (r.unusable) {
				unusable.add(n);
				return;
			}
			if (r.ok) {
				done.add(n);
				pi.appendEntry("nerd-step", { step: n, cmd: r.cmd, rc: r.rc ?? 0, commit: head, done: true });
			} else if (!red) red = { ...r, n };
		});
		if (red) pi.appendEntry("nerd-step", { step: red.n, cmd: red.cmd, rc: red.rc ?? null, commit: head, done: false });
		const shown = steps.map((s) => (unusable.has(s.n) ? { n: s.n, claim: s.claim } : s));
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${stepNote(shown, done, red, head)}` }],
			structuredContent: event.structuredContent,
		};
	});

	return {
		/** The steps done so far (for tests). */
		done: () => [...done].sort((a, b) => a - b),
	};
}
