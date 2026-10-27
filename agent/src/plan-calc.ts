// A calculator in the plan step (process ticket 094; operator, 2026-10-17). In the tax runs of
// ticket 090 9-26% of Bonsai's thinking in the plan step was arithmetic done by hand — the
// expected values of Done when — and they were wrong more than once ("expected values in PLAN.md
// are my own planning-phase arithmetic errors", 092). The calc guard (calc-guard.ts) is silent
// there: the step's tools only read, so there is nothing to compute with. So:
//
//   - NERD_PLAN_CALC=1: the plan step has `calc`, which runs a Python program (`python3 -I -c`)
//     in an empty temporary directory with a 20 s timeout and gives back at most 4000 characters
//     of what it printed. It is not a work tool: the work has bash.
//   - NERD_PLAN_CALC_NOTE: text added to the plan step's prompt — the stimulus under test (a rule,
//     a reason, a threat, a reward, an example; the stand keeps the texts). Unset: the prompt is
//     as without the calculator, and the tool's description is all the model is told.
//   - NERD_PLAN_CALC_LINT=1: plan-lint takes a number in a Done when check that is neither in the
//     task, nor an input of the code under test, nor printed by a calc call of this step, as an
//     error (the plan goes back once, as with every plan-lint error).

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const CALC_TOOL = "calc";
export const CALC_TIMEOUT_S = 20;
export const CALC_MAX_CHARS = 4000;

export function planCalcOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_PLAN_CALC === "1";
}

export function planCalcLintOn(env: Record<string, string | undefined> = process.env): boolean {
	return planCalcOn(env) && env.NERD_PLAN_CALC_LINT === "1";
}

/** The stimulus added to the plan step's prompt ("" without the calculator or without a note). */
export function planCalcNote(env: Record<string, string | undefined> = process.env): string {
	return planCalcOn(env) ? (env.NERD_PLAN_CALC_NOTE ?? "").trim() : "";
}

export const CALC_DESCRIPTION =
	`Runs a Python 3 program and returns what it printed (stdout, then stderr) and its exit code. ` +
	`Use print() for every value you want to see. The program runs with python3 -I in an empty temporary directory, ` +
	`not in the project, and is killed after ${CALC_TIMEOUT_S} s; output over ${CALC_MAX_CHARS} characters is cut.`;

/** Output over `max` characters: its head and tail with a note between. */
export function capOutput(text: string, max = CALC_MAX_CHARS): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 60) / 2);
	return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

export interface CalcRun {
	output: string;
	code: number | null;
	timedOut: boolean;
}

/** Runs `program` with python3 -I in a fresh temporary directory, removed afterwards. */
export function runCalc(program: string, timeoutS = CALC_TIMEOUT_S, signal?: AbortSignal): Promise<CalcRun> {
	const dir = mkdtempSync(join(tmpdir(), "nerd-calc-"));
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
	return new Promise((resolve) => {
		execFile(
			"python3",
			["-I", "-c", program],
			{ cwd: dir, env, timeout: timeoutS * 1000, killSignal: "SIGKILL", maxBuffer: 1 << 20, signal },
			(err, stdout, stderr) => {
				rmSync(dir, { recursive: true, force: true });
				const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const timedOut = !!e?.killed;
				const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
				const out = [stdout, stderr].filter((s) => s.length).join(stdout.endsWith("\n") || !stdout ? "" : "\n");
				const why = e && !timedOut && typeof e.code !== "number" ? `${e.message}\n` : "";
				resolve({ output: why + out, code, timedOut });
			},
		);
	});
}

export function calcResultText(r: CalcRun, timeoutS = CALC_TIMEOUT_S): string {
	const out = capOutput(r.output);
	if (r.timedOut) return `${out}${out && !out.endsWith("\n") ? "\n" : ""}[killed after ${timeoutS} s]`;
	if (r.code === 0) return out || "[no output: print() the values you want to see]";
	return `${out}${out && !out.endsWith("\n") ? "\n" : ""}[exit code ${r.code}]`;
}

/** The `calc` tool, for registerTool (TUI) and customTools (headless). */
export function calcTool() {
	return defineTool({
		name: CALC_TOOL,
		label: "calc",
		description: CALC_DESCRIPTION,
		parameters: Type.Object({ program: Type.String({ description: "The Python 3 program to run" }) }),
		async execute(_id, params, signal) {
			const r = await runCalc(params.program, CALC_TIMEOUT_S, signal);
			const text = calcResultText(r);
			return { content: [{ type: "text" as const, text }], details: undefined, isError: r.timedOut || r.code !== 0 };
		},
	});
}

// --- mechanism M: the numbers of Done when against what calc printed ---------------------------

const NUMBER = /(?<![\w.$])-?\d[\d_]*(?:\.\d+)?(?![\w])/g;

function toNumber(s: string): number {
	return Number(s.replace(/[_,]/g, ""));
}

/** Every number a calc output holds (12,345.67 and 12_345 read as one number). */
export function outputNumbers(outputs: string[]): number[] {
	const out: number[] = [];
	for (const o of outputs) for (const m of o.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d[\d_]*(?:\.\d+)?/g)) out.push(toNumber(m[0]));
	return out.filter((n) => Number.isFinite(n));
}

// Calls that hold a check's expected values, not the code's inputs: `process.exit(r.tax===549.75?0:1)`
// was read as an input on the stand of 094, and every number of such a check passed as one.
const NOT_INPUT = /^(exit|assert\w*|ok|equal|strictEqual|deepEqual|deepStrictEqual|notEqual|log|error|then|catch|import|require|abs|toFixed|round)$/;

/** The numbers passed to the innermost calls of a check (`tax(100000)`) and a binary's arguments: the inputs. */
export function inputNumbers(cmd: string): number[] {
	const out: number[] = [];
	for (const m of cmd.matchAll(/([\w$]+)\s*\(([^()]*)\)/g)) {
		if (NOT_INPUT.test(m[1])) continue;
		for (const n of m[2].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ").matchAll(NUMBER)) out.push(toNumber(n[0]));
	}
	const args = /\bcargo\s+run\b[^|;&]*?\s--\s+([^|;&<>]*\S)/.exec(cmd)?.[1];
	if (args) for (const n of args.matchAll(NUMBER)) out.push(toNumber(n[0]));
	return out;
}

function decimals(s: string): number {
	const i = s.indexOf(".");
	return i < 0 ? 0 : s.length - i - 1;
}

/** Whether `s` is one of `printed`, or one of them rounded to s's decimals. */
export function printedAs(s: string, printed: number[]): boolean {
	const v = toNumber(s);
	const d = decimals(s);
	return printed.some((p) => p === v || Math.abs(Math.round(p * 10 ** d) / 10 ** d - v) < 10 ** -(d + 3));
}

/**
 * The numbers of a check that nothing accounts for: not in the task, not an input of the code
 * under test, not printed by calc. Single digits (exit codes, indices, toFixed(2)) are left out.
 */
export function uncomputed(cmd: string, task: string, printed: number[]): string[] {
	const t = task.replace(/\s+/g, " ");
	const fromTask = [...t.matchAll(/-?\d{1,3}(?:[ ,_]\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)].map((m) => toNumber(m[0].replace(/ /g, "")));
	const inputs = inputNumbers(cmd);
	const out: string[] = [];
	for (const m of cmd.matchAll(NUMBER)) {
		const s = m[0].replace(/^-/, "");
		const v = toNumber(s);
		if (!Number.isFinite(v) || (Number.isInteger(v) && v < 10 && !s.includes("."))) continue;
		if (fromTask.includes(v) || fromTask.includes(-v) || inputs.includes(v) || inputs.includes(-v)) continue;
		if (printedAs(s, printed) || printedAs(`-${s}`, printed)) continue;
		if (!out.includes(s)) out.push(s);
	}
	return out;
}

export function uncomputedMessage(numbers: string[]): string {
	const list = numbers.map((n) => `\`${n}\``).join(", ");
	return `${numbers.length > 1 ? "the numbers" : "the number"} ${list} in this check ${numbers.length > 1 ? "are" : "is"} not in the task and no \`calc\` call of this step printed ${numbers.length > 1 ? "them" : "it"}: an expected value worked out in your head is often wrong. Compute it with \`calc\` from the task's rules, print it, and copy it from the output`;
}
