// The repeat guard (ticket 071 of the process, layer 3): a reply whose tail is the
// same piece of text over and over is cut, and the model is told what it repeated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { repeatGuard, repeatSteer, tailLoop } from "../src/repeat-guard.ts";

test("tailLoop: the same unit three times and more at the end is a loop", () => {
	const unit = "Let me re-check the test for allocate once more before I write it.\n";
	const l = tailLoop(`I read the file.\n${unit.repeat(6)}`);
	assert.ok(l);
	assert.equal(l.period, unit.length);
	assert.ok(l.copies >= 3);
	// a short unit (one token over and over) is caught too, as a multiple of it
	assert.equal((tailLoop(`x\n${"ab".repeat(400)}`)?.period ?? 0) % 2, 0);
	assert.ok(tailLoop(`x\n${"ab".repeat(400)}`));
});

test("tailLoop: legitimate repetition is not a loop", () => {
	// a test list, a table, code with similar lines: each line differs
	const tests = Array.from({ length: 40 }, (_, i) => `  assert.equal(parse("${i}h"), ${i * 3600});\n`).join("");
	assert.equal(tailLoop(`test("parse", () => {\n${tests}});\n`), undefined);
	const table = Array.from({ length: 30 }, (_, i) => `| row ${i} | ok | ${i * 7} ms |\n`).join("");
	assert.equal(tailLoop(table), undefined);
	// two identical blocks are not enough, nor is a short total
	const block = "function f() {\n  return compute(a, b, c);\n}\n";
	assert.equal(tailLoop(`${block}${block}`), undefined);
	assert.equal(tailLoop("0123456789abcdefghijklmnopqrstuvwxyz!".repeat(3)), undefined, "under 300 characters in all");
});

test("tailLoop: a loop of one long paragraph", () => {
	const para = `${"The allocation must sum to the total and the remainder goes to the largest fractions first. ".repeat(4)}\n\n`;
	assert.equal(tailLoop(`Plan:\n${para.repeat(3)}`)?.period, para.length);
});

test("the extension cuts a looping reply, hands over the steer, at most twice per task", () => {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	let aborts = 0;
	const pi = { on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h), appendEntry: () => {}, sendUserMessage: () => {} };
	const g = repeatGuard(pi as unknown as Parameters<typeof repeatGuard>[0], { operator: false });
	const ctx = { abort: () => aborts++ };
	const loop = `ok\n${"I will now run the tests again to be sure.\n".repeat(12)}`;
	const stream = () => {
		handlers.get("message_start")?.({}, ctx);
		for (let k = 50; k <= loop.length; k += 50) handlers.get("message_update")?.({ message: { role: "assistant", content: [{ type: "text", text: loop.slice(0, k) }] } }, ctx);
		handlers.get("message_end")?.({}, ctx);
	};
	handlers.get("before_agent_start")?.({ prompt: "build it" }, ctx);
	stream();
	assert.equal(aborts, 1);
	assert.match(g.takeSteer() ?? "", /cut/);
	assert.equal(g.takeSteer(), undefined, "once");
	stream();
	assert.equal(aborts, 2);
	assert.match(g.takeSteer() ?? "", /second time/);
	stream();
	assert.equal(aborts, 2, "no third cut in the same task");
	handlers.get("before_agent_start")?.({ prompt: "a new message of the operator" }, ctx);
	stream();
	assert.equal(aborts, 3, "a new operator message starts a fresh budget");
});

test("the steer names what was repeated, shortened", () => {
	const s = repeatSteer(1, "Let me re-check the test ".repeat(20));
	assert.match(s, /repeat/i);
	assert.ok(s.length < 900);
	assert.match(repeatSteer(2, "x".repeat(50)), /blocker|cannot/i);
});
