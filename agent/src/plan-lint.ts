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
import { uncomputed, uncomputedMessage } from "./plan-calc.ts";

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

// TODO but not Rust's todo!() macro (process ticket 093: "replace the two `todo!` stubs").
const PLACEHOLDER = /\b(TBD|TODO(?!!)|FIXME|XXX)\b|\bas in step \d+|\bsame as (step \d+|above)\b|\bhandle (the |all )?edge cases\b|\bask the user\b|\bto be decided\b|<step>|<what the operator|<a shell command/i;
const TOOL_MARKUP = /<tool_call>|<function=|<\/?parameter[ =>]/;
const OUTPUT_WORDS = /\b(prints?|shows?|outputs?|displays?|lists?|should (be|print|show|return|output)|returns? \d+ lines?)\b/i;
const NEGATIVE = /\b(no|not|none|never|without|zero|0 lines?)\b/i;
/** A test runner's output piped into a text filter: `npm test | grep …`, `node --test 2>&1 | tail`. */
const RUNNER_TEXT = /\b(npm\s+(run\s+)?test|npm\s+t|node\s+--test|npx\s+(jest|vitest|mocha)|cargo\s+test|pytest)\b(?:[^|;&]|2>&1)*\|\s*(grep|egrep|tail|head|wc|awk|sed)\b/;

// Ticket 080 of the process: a planner whose Done when was only `npm test`, `test -f`
// and "the exports are functions" let a wrong compare() through (semver, 11 of 572
// external checks), and no Ralph round ever started in 12 runs. A behavior check
// runs the code on a concrete input: an inline program that calls something with a
// literal argument, a script file, or a request to a running service. The test suite
// does not count — the work may write it itself.
const INLINE_PROGRAM = /\b(node|bun|deno|python3?)\b[^|;&]*?\s(-e|--eval|-p|--print|-c|eval)\s+(["'])([\s\S]*?)\3/;
// Process ticket 090: a Rust library's inline program (container/nerd-rs-eval.mjs).
const RS_EVAL = /\bnerd-rs-eval\b(?:\s+-C\s+\S+)?\s+(["'])([\s\S]*?)\1/;
const CALL_WITH_INPUT = /[\w$\]\)]\s*\(\s*(?:["'`\d\[{-]|new\b|null\b|undefined\b|true\b|false\b)/;
// A Rust binary run on an input: arguments after `--`, or something piped or redirected into it.
const CARGO_RUN_ARGS = /\bcargo\s+run\b[^|;&]*?\s--\s+([^|;&<>]*\S)/;
// … and a built binary, with or without ./, given arguments or a pipe (process ticket 093).
const RUST_BINARY_INPUT = /\|\s*cargo\s+run\b|\bcargo\s+run\b[^|;&]*<\s*\S|(^|[;&|(]\s*)(\.\/)?target\/(debug|release)\/[\w-]+\s+[^\s|;&)]|\|\s*(\.\/)?target\/(debug|release)\/[\w-]+/;

/** The inline program of a check (node -e, python -c, nerd-rs-eval), or undefined. */
function inlineProgram(cmd: string): string | undefined {
	const n = cmd.match(INLINE_PROGRAM);
	if (n) return n[4];
	return cmd.match(RS_EVAL)?.[2];
}

/** The program without the harness's own calls (an import, an exit, a print): they are not the code under test. */
function ownCalls(program: string): string {
	return program
		.replace(/\bimport\s*\(\s*["'][^"']*["']\s*\)/g, "import()")
		.replace(/\b(process\.exit|console\.\w+|require|(?:std::)?process::exit)\s*\(/g, " ");
}

/** Whether a Done when command runs the code on a concrete input. */
export function exercisesBehavior(cmd: string): boolean {
	const program = inlineProgram(cmd);
	if (program !== undefined) return CALL_WITH_INPUT.test(ownCalls(program));
	// A program from a heredoc: its body is not on the item's line, give it the benefit.
	if (/\b(node|bun|deno|python3?)\s+-\s*<</.test(cmd)) return true;
	if (/\bcurl\b|\bwget\b/.test(cmd)) return true;
	if (CARGO_RUN_ARGS.test(cmd) || RUST_BINARY_INPUT.test(cmd)) return true;
	return /(^|[;&|]\s*)(node|bun|deno|python3?)\s+(?!--check\b|--test\b|-v\b|--version\b)[\w./-]+\.(m?js|ts|py)\b/.test(cmd);
}

// Ticket 083 of the process: 9 of 13 stand failures had the rule in the plan and a
// check of it only on the task's own example (allocate(3,[0.3,0.1,0.2])) or on a
// property the bug keeps (the parts add up to total). NERD_PLAN_LINT_OWN_INPUT=1:
// at least one behavior check must use an input that is not in the task's text.
export function ownInputOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_PLAN_LINT_OWN_INPUT === "1";
}

/** The literal inputs of a check's calls: strings and numbers inside the call arguments. */
export function callLiterals(cmd: string): string[] {
	const inline = inlineProgram(cmd);
	const program = ownCalls(inline ?? cmd);
	const out: string[] = [];
	// A binary's arguments are its inputs (`cargo run -q -- 3000000 7`).
	const args = inline === undefined ? cmd.match(CARGO_RUN_ARGS)?.[1] : undefined;
	if (args) for (const w of args.split(/\s+/)) out.push(w.replace(/^(["'])(.*)\1$/, "$2"));
	for (const m of program.matchAll(/[\w$\])]\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
		for (const s of m[1].matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push(s[2]);
		for (const n of m[1].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ").matchAll(/-?\d+(?:\.\d+)?/g)) out.push(n[0]);
	}
	return out;
}

/** Whether a check's inputs include one that the task's text does not contain. */
export function hasOwnInput(cmd: string, task: string): boolean {
	const t = task.replace(/\s+/g, " ");
	// Single digits are in every task; they say nothing about where an input came from.
	return callLiterals(cmd).some((l) => l.trim() !== "" && !/^-?\d$/.test(l) && !t.includes(l.replace(/\s+/g, " ")));
}

/**
 * The highest amount the task's rules start from ("… on the part over 1 107 750", "above
 * 100 000"): undefined when there is none of at least 100 (smaller ones are counts and lengths,
 * whose checks need no number past them).
 */
export function highestThreshold(task: string): number | undefined {
	let max: number | undefined;
	for (const m of task.matchAll(/\b(?:over|above|exceeds?|exceeding|more than|greater than|in excess of)\s+[$€£]?\s*(\d{1,3}(?:[ ,_]\d{3})+|\d+)(?:\.\d+)?/gi)) {
		const v = Number(m[1].replace(/[ ,_]/g, ""));
		if (v >= 100 && (max === undefined || v > max)) max = v;
	}
	return max;
}

/** The numbers a check calls the code with (3_000_000 read as one number). */
export function callNumbers(cmd: string): number[] {
	return callLiterals(cmd.replace(/(\d)_(?=\d)/g, "$1"))
		.map(Number)
		.filter((n) => Number.isFinite(n));
}

/** Findings for a plan; `checks`: the plan form asked for check commands (the Ralph loop). */
/** How a check calls the code: JS by default, Rust for a Cargo project (process ticket 090). */
export function behaviorExample(rust?: boolean): string {
	return rust
		? "e.g. `nerd-rs-eval 'assert_eq!(f(\"in\"), \"out\");'` for a library — it runs Rust statements with the crate's items in scope and fails when an assert! fails — or `cargo run -q -- <args> | grep -qx <output>` for a binary; `cargo test` runs tests the work may write itself"
		: "e.g. `node -e \"import('./x.js').then(m=>process.exit(m.f('in')==='out'?0:1))\"`";
}

/**
 * `calcPrinted`: the numbers the plan step's calc calls printed (plan-calc.ts, NERD_PLAN_CALC_LINT=1);
 * with it, a number of a check that is neither in the task, an input, nor printed is an error.
 */
export function lintPlan(text: string, opts: { checks: boolean; ownInput?: boolean; rust?: boolean; calcPrinted?: number[] }): Finding[] {
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
	const taskText = lines.filter((l) => l.trim().startsWith(">")).join("\n");
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
		if (RUNNER_TEXT.test(i.cmd)) {
			// Process ticket 089: `npm test | grep -q "2 tests passed"` — node --test prints no such
			// line, and the model made the check pass by rewriting scripts.test to echo it.
			at(i.line, "error", `it reads the text the test runner prints: that wording is the runner's, not the work's, and the only way to make such a check pass is to change the test script or the runner. Use \`${opts.rust ? "cargo test" : "npm test"}\` alone (the harness reads its exit code), and check the behaviour with commands that call the code`);
		}
		if (opts.calcPrinted) {
			// Process ticket 094, mechanism M: an expected value must come from a calc output.
			const loose = uncomputed(i.cmd, taskText, opts.calcPrinted);
			if (loose.length) at(i.line, "error", uncomputedMessage(loose));
		}
		if (/(^|[\s=;&|(])\/workspace\b/.test(i.cmd)) at(i.line, "warning", "the check names /workspace: it runs from the project root of a clean clone, so use relative paths");
		const greps = i.cmd.split(/&&|\|\||;|\|/).map((s) => s.trim());
		if (greps.some((s) => /^grep\b/.test(s)) && !greps.some((s) => /^!\s*grep\b/.test(s)) && NEGATIVE.test(`${i.claim} ${i.after}`)) {
			at(i.line, "warning", "grep exits 1 when it finds nothing: for a claim that something is absent write `! grep -q …`");
		}
	}
	if (items.some((i) => i.cmd) && !items.some((i) => i.cmd && exercisesBehavior(i.cmd))) {
		at(
			items[0].line,
			"error",
			`no Done when check runs the code on a concrete input: \`${opts.rust ? "cargo test" : "npm test"}\` runs tests the work may write itself, and checks that files or exports exist pass on wrong code. Add checks that call the code with inputs from the task — first the cases the task singles out — and exit 1 when the result differs (${behaviorExample(opts.rust)})`,
		);
	} else if (opts.ownInput) {
		const task = lines.filter((l) => l.trim().startsWith(">")).join("\n");
		const behavior = items.filter((i) => i.cmd && exercisesBehavior(i.cmd));
		if (task && behavior.length && !behavior.some((i) => hasOwnInput(i.cmd as string, task))) {
			at(
				behavior[0].line,
				"error",
				"every behavior check uses only the task's own examples: an example passes on code that gets the rule wrong elsewhere. For each rule of the task add a check on an input of your own with the value you expect — the edge the rule is about (a zero, an uppercase letter from a mapping, a cut at the limit, numbers with different decimals, equal versions), not the example again and not only a property such as a sum",
			);
		}
	}
	// Process ticket 089: 4 of 5 failures on substance read "x% on the part over T" as a band
	// that stops at the next threshold, and no check of the plan went past the threshold.
	const top = highestThreshold(lines.filter((l) => l.trim().startsWith(">")).join("\n"));
	const behaving = items.filter((i) => i.cmd && exercisesBehavior(i.cmd));
	if (top !== undefined && behaving.length && !behaving.some((i) => callNumbers(i.cmd as string).some((n) => n > top))) {
		at(
			behaving[0].line,
			"error",
			`no check calls the code above the task's highest threshold (${top}): a rule that applies "on the part over" an amount is read wrong most often there — as a band that stops at the next threshold. Add a check with an input past each threshold the task names, the expected value worked out by hand`,
		);
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
