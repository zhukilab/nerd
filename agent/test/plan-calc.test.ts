// The plan step's calculator (process ticket 094): what calc runs and gives back, and plan-lint's
// mechanism M — a number of a Done when check must be in the task, an input, or a calc output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capOutput, calcResultText, inputNumbers, outputNumbers, planCalcLintOn, planCalcNote, printedAs, runCalc, uncomputed } from "../src/plan-calc.ts";
import { lintPlan } from "../src/plan-lint.ts";
import { planStepPrompt } from "../src/plan-step.ts";

test("calc: runs python3 -I in an empty directory and gives back what it printed", async () => {
	const r = await runCalc("import os, sys\nprint(2 + 3)\nprint(os.listdir('.'), sys.flags.isolated)");
	assert.equal(r.code, 0);
	assert.equal(r.output, "5\n[] 1\n");
	assert.equal(calcResultText(r), "5\n[] 1\n");
});

test("calc: an error gives its traceback and the exit code; no output says to print", async () => {
	const r = await runCalc("1/0");
	assert.equal(r.code, 1);
	assert.match(calcResultText(r), /ZeroDivisionError[\s\S]*\[exit code 1\]$/);
	assert.match(calcResultText(await runCalc("x = 2 + 3")), /no output: print\(\)/);
});

test("calc: killed at its timeout", async () => {
	const r = await runCalc("print('start', flush=True)\nwhile True: pass", 1);
	assert.ok(r.timedOut);
	assert.match(calcResultText(r, 1), /^start\n\[killed after 1 s\]$/);
});

test("calc: long output is cut to head and tail", () => {
	const s = "a".repeat(3000) + "b".repeat(3000);
	const c = capOutput(s, 1000);
	assert.ok(c.length <= 1000);
	assert.ok(c.startsWith("aaa") && c.endsWith("bbb") && c.includes("characters cut"));
	assert.equal(capOutput("short", 1000), "short");
});

test("calc settings: the note and the lint only with NERD_PLAN_CALC=1; the note goes after the form", () => {
	assert.equal(planCalcNote({ NERD_PLAN_CALC_NOTE: "use calc" }), "");
	assert.equal(planCalcNote({ NERD_PLAN_CALC: "1", NERD_PLAN_CALC_NOTE: " use calc \n" }), "use calc");
	assert.equal(planCalcLintOn({ NERD_PLAN_CALC_LINT: "1" }), false);
	assert.equal(planCalcLintOn({ NERD_PLAN_CALC: "1", NERD_PLAN_CALC_LINT: "1" }), true);
	assert.match(planStepPrompt(true, false, "Every number through calc."), /DONE WHEN\n[\s\S]*\n\nEvery number through calc\.$/);
	assert.doesNotMatch(planStepPrompt(true, false, ""), /\n\n$/);
});

test("M: output numbers, inputs, and a value printed with more decimals", () => {
	assert.deepEqual(outputNumbers(["tax 12,345.67\n-3 and 1_000"]), [12345.67, -3, 1000]);
	assert.deepEqual(inputNumbers(`node -e "import('./t.js').then(m=>process.exit(m.tax(80000, 'ON')===3000?0:1))"`), [80000]);
	assert.deepEqual(inputNumbers("cargo run -q -- 3000000 7 | grep -qx 12.5"), [3000000, 7]);
	assert.deepEqual(inputNumbers("nerd-rs-eval 'assert_eq!(tax(80000), 3000);'"), [80000]);
	// The stand of 094: expected values inside process.exit(...) are not inputs.
	const exitForm = `node -e "import('./lib/tax.js').then(m=> { const r = m.payroll('CA-ON', 10000); process.exit(r.incomeTax===0 && r.contributions===549.75 ? 0 : 1) })"`;
	assert.deepEqual(inputNumbers(exitForm), [10000]);
	assert.deepEqual(uncomputed(exitForm, TASK, []), ["549.75"]);
	assert.deepEqual(inputNumbers("node -e \"assert.ok(Math.abs(f(80000) - 3000.5) < 0.01)\""), [80000]);
	assert.ok(printedAs("3000.00", [2999.996]));
	assert.ok(printedAs("3000", [3000]));
	assert.ok(!printedAs("3000.01", [3000]));
});

const TASK = "> Tax is 10% on the part over 50 000.";
const CHECK = `node -e "import('./tax.js').then(m=>process.exit(m.tax(80000)===3000?0:1))"`;

test("M: a check's expected value not printed by calc is reported; the task's numbers and inputs are not", () => {
	assert.deepEqual(uncomputed(CHECK, TASK, []), ["3000"]);
	assert.deepEqual(uncomputed(CHECK, TASK, [3000]), []);
	assert.deepEqual(uncomputed(`node -e "const a=require('assert');a.equal(require('./t.js').tax(80000), 3000.5)"`, TASK, []), ["3000.5"]);
	assert.deepEqual(uncomputed(`node -e "process.exit(require('./t.js').tax(50000)===0?0:1)"`, TASK, []), [], "zero and the threshold");
});

test("M in plan-lint: only with calcPrinted; the finding names the number", () => {
	const plan = `# Plan\n\n## Task\n\n${TASK}\n\n## Steps\n\n1. write tax.js — check: \`npm test\`\n\n## Done when\n\n- tax over the threshold — check: \`${CHECK}\`\n`;
	const without = lintPlan(plan, { checks: true });
	assert.ok(!without.some((f) => /calc/.test(f.message)));
	const missing = lintPlan(plan, { checks: true, calcPrinted: [] }).filter((f) => /calc/.test(f.message));
	assert.equal(missing.length, 1);
	assert.equal(missing[0].severity, "error");
	assert.match(missing[0].message, /the number `3000` in this check is not in the task/);
	assert.ok(!lintPlan(plan, { checks: true, calcPrinted: [3000] }).some((f) => /calc/.test(f.message)));
});
