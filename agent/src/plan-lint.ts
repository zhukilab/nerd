// plan-lint (ticket 065 of the process): the harness checks PLAN.md after the
// plan step and before the plan is frozen, because the model does not keep
// prose rules. On the stand of ticket 060 (2026-10-09) every one of the six
// Ralph stops came from a Done when check the frozen plan could not fix: one
// that cannot fail, one in a form the harness did not read, one that does not
// parse, one whose expected output was only stated in words. Errors go back to
// the model once, with the lines quoted; what is still wrong after that is
// written into PLAN.md and the work goes on (it is never blocked).
// NERD_PLAN_LINT=0 turns it off. The rules are our own (the idea of a plan
// linter after superpowers writing-plans and @mjasnikovs/pi-task; no code taken).

import { doneWhenLines, syntaxError, unfailable } from "./done-when.ts";

export interface Finding {
	severity: "error" | "warning";
	/** 1-based line in the plan text. */
	line: number;
	/** The line itself, trimmed. */
	text: string;
	message: string;
}

export function planLintOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_PLAN_LINT !== "0";
}

const PLACEHOLDER = /\b(TBD|TODO|FIXME|XXX)\b|\bas in step \d+|\bsame as (step \d+|above)\b|\bhandle (the |all )?edge cases\b|\bask the user\b|\bto be decided\b|<step>|<what the operator|<a shell command/i;
const TOOL_MARKUP = /<tool_call>|<function=|<\/?parameter[ =>]/;
const OUTPUT_WORDS = /\b(prints?|shows?|outputs?|displays?|lists?|should (be|print|show|return|output)|returns? \d+ lines?)\b/i;
const NEGATIVE = /\b(no|not|none|never|without|zero|0 lines?)\b/i;

/** Findings for a plan; `checks`: the plan form asked for check commands (the Ralph loop). */
export function lintPlan(text: string, opts: { checks: boolean }): Finding[] {
	const lines = text.split("\n");
	const out: Finding[] = [];
	const at = (line: number, severity: Finding["severity"], message: string) =>
		out.push({ severity, line, text: (lines[line - 1] ?? "").trim(), message });

	let steps = false;
	for (const [k, raw] of lines.entries()) {
		const l = raw.trim();
		if (TOOL_MARKUP.test(l)) {
			at(k + 1, "error", "tool call markup instead of plan text: the tools of this turn are put away, so a call written as text is not run; write the plan itself");
			break;
		}
		if (/^#{1,3}\s*(steps|plan)\s*$/i.test(l) || /^PLAN\s*$/.test(l)) steps = true;
		else if (/^#{1,3}\s/.test(l) || /^[A-Z][A-Z ]+$/.test(l)) steps = false;
		if (l.startsWith(">")) continue; // the task, quoted
		if (PLACEHOLDER.test(l)) at(k + 1, "error", "a placeholder or a deferral: say what will actually be done");
		if (steps && /^\d+[.)]\s/.test(l) && !/check:/i.test(l)) at(k + 1, "warning", "a step without `check:` — how will you know it is done?");
	}

	const items = doneWhenLines(text);
	if (!opts.checks) return out;
	if (!items || items.length === 0) {
		at(lines.length, "error", "no Done when items: every requirement needs one, with the command that checks it");
		return out;
	}
	for (const i of items) {
		if (!i.cmd) {
			const split = (i.claim.match(/`/g) ?? []).length % 2 === 1 ? " The command must be on the item's one line, in one pair of backticks." : "";
			at(i.line, "error", `no command the harness can run: write it as \`- <claim> — check: \`<command>\`\`, the command in backticks, exiting 0 only if the claim is true.${split}`);
			continue;
		}
		const never = unfailable(i.cmd);
		if (never) at(i.line, "error", `the check cannot fail: ${never}`);
		const bad = syntaxError(i.cmd);
		if (bad) at(i.line, "error", bad);
		if (!never && OUTPUT_WORDS.test(i.after) && !/\b(exits?|exit code)\b[^.;]*\b0\b/i.test(i.after)) {
			at(i.line, "error", `the expected output is only in words ("${i.after.slice(0, 60)}"): the harness reads the exit code; make the command fail when the output is wrong (\`| grep -q …\`, process.exit, assert)`);
		}
		if (/(^|[\s=;&|(])\/workspace\b/.test(i.cmd)) at(i.line, "warning", "the check names /workspace: it runs from the project root of a clean clone, so use relative paths");
		const greps = i.cmd.split(/&&|\|\||;|\|/).map((s) => s.trim());
		if (greps.some((s) => /^grep\b/.test(s)) && !greps.some((s) => /^!\s*grep\b/.test(s)) && NEGATIVE.test(`${i.claim} ${i.after}`)) {
			at(i.line, "warning", "grep exits 1 when it finds nothing: for a claim that something is absent write `! grep -q …`");
		}
	}
	return out;
}

/** What the model gets back for its one retry. */
export function lintRetryMessage(findings: Finding[]): string {
	const rows = findings.map((f) => `- line ${f.line} (${f.severity}): \`${f.text.slice(0, 200)}\`\n  ${f.message}`).join("\n");
	return `[harness] plan-lint found problems in the plan. The Done when commands are what the harness runs in a clean clone after the work, reading only their exit codes, and they cannot be changed once the plan is saved:
${rows}
Reply with the corrected final plan in the same form (PLAN, then DONE WHEN; no QUESTIONS). Files still cannot be changed in this turn.`;
}

/** The PLAN.md section for what is still wrong after the retry. */
export function lintSection(findings: Finding[]): string {
	if (!findings.length) return "";
	return `\n## Plan lint\n\nNot fixed after one retry; the work goes on:\n${findings.map((f) => `- line ${f.line} (${f.severity}): ${f.message}`).join("\n")}\n`;
}
