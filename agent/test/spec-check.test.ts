// The spec-check loop without a server: verdict parsing, the prompt, and when
// rounds stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerdict, runSpecCheck, specCheckPrompt } from "../src/spec-check.ts";

test("the last verdict line wins, case and spacing are loose", () => {
	assert.deepEqual(parseVerdict("SPEC CHECK: 3 clauses, 1 failed\nfixed\nspec check:  7 clause, 0 failed"), {
		clauses: 7,
		failed: 0,
	});
	assert.equal(parseVerdict("all good"), undefined);
});

test("verdicts that copied the placeholder's words are still read (ticket 030)", () => {
	assert.deepEqual(parseVerdict("SPEC CHECK: 7 clauses, 0 checks that failed on the first run in this reply"), {
		clauses: 7,
		failed: 0,
	});
	assert.deepEqual(parseVerdict("SPEC CHECK: 9 clauses, 4 checks that failed on the first run in this reply failed"), {
		clauses: 9,
		failed: 4,
	});
	assert.deepEqual(parseVerdict("**SPEC CHECK: 5 clauses, 0 checks failed**"), { clauses: 5, failed: 0 });
});

test("the prompt carries the task text verbatim and asks for the verdict line", () => {
	const p = specCheckPrompt("Throws a RangeError for x.", 1);
	assert.ok(p.includes("<<<\nThrows a RangeError for x.\n>>>"));
	assert.ok(p.trimEnd().endsWith("SPEC CHECK: 12 clauses, 0 failed"));
	assert.ok(!p.includes("re-check"));
	assert.ok(specCheckPrompt("t", 2).includes("re-check"));
});

function fakeSession(replies: { text: string; stopReason?: string }[]) {
	const messages: unknown[] = [];
	const prompts: string[] = [];
	return {
		messages,
		prompts,
		async prompt(text: string) {
			prompts.push(text);
			const r = replies.shift() ?? { text: "" };
			messages.push({ role: "user", content: text });
			messages.push({ role: "assistant", stopReason: r.stopReason ?? "stop", content: [{ type: "text", text: r.text }] });
		},
	};
}

test("a clean first round ends the check", async () => {
	const s = fakeSession([{ text: "SPEC CHECK: 5 clauses, 0 failed" }]);
	const rounds = await runSpecCheck(s, "task", { maxRounds: 3 });
	assert.equal(rounds.length, 1);
	assert.equal(s.prompts.length, 1);
});

test("failures and missing verdicts re-enter, up to the bound", async () => {
	const s = fakeSession([
		{ text: "SPEC CHECK: 5 clauses, 2 failed" },
		{ text: "no verdict here" },
		{ text: "SPEC CHECK: 5 clauses, 0 failed" },
	]);
	const seen: number[] = [];
	const rounds = await runSpecCheck(s, "task", { maxRounds: 3, onRound: (r) => seen.push(r.round) });
	assert.deepEqual(seen, [1, 2, 3]);
	assert.equal(rounds[2].verdict?.failed, 0);

	const t = fakeSession([{ text: "SPEC CHECK: 1 clauses, 1 failed" }, { text: "SPEC CHECK: 1 clauses, 1 failed" }]);
	assert.equal((await runSpecCheck(t, "task", { maxRounds: 2 })).length, 2);
});

test("a round that does not end by itself stops the loop", async () => {
	const s = fakeSession([{ text: "SPEC CHECK: 5 clauses, 2 failed", stopReason: "length" }]);
	assert.equal((await runSpecCheck(s, "task", { maxRounds: 3 })).length, 1);
});
