// The calc guard (process ticket 090, stage 3): a reply of the work that computes by hand is
// cut and told to write the calculation as a program, at most twice per task.
import assert from "node:assert/strict";
import { test } from "node:test";
import { arithLines, calcGuard, calcSteer } from "../src/calc-guard.ts";

// From b-rs-tax-1's reply cut by the work clock (2026-10-16).
const HAND = [
	"municipal = 0.25049 * max(0, 2_668_000 - 63_300 - 3_100 - 54_100) = 0.25049 * 2_547_500.",
	"2_547_500 * 0.25 = 636_875.",
	"2_547_500 * 0.00049 = 1248.275.",
	"Total = 636_875 + 1248.275 = 638_123.275.",
	"2_613_900 * 0.12 = 313_668.",
	"2_613_900 * 0.0001 = 261.39.",
	"313_668 + 261.39 = 313_929.39",
	"36932.93 + 22342.18 = 59275.11",
	"59275.11 + 13329.03 = 72604.14 ✓",
	"2721.4955 + 4931.301 = 7652.7965",
	"7652.7965 + 4711.194 = 12363.9905",
	"12363.9905 + 8512.0 = 20875.9905",
];

test("arithLines: hand calculations, not code or prose with numbers", () => {
	assert.equal(arithLines(HAND.join("\n")).length, HAND.length);
	const not = [
		"let tax = 0.05 * taxable + 0.04 * part(taxable, 1_107_750.0, INF);",
		"The 2026 band is 13% up to 2 400 000.",
		"assert_eq!(to_roman(4), Some(\"IV\".into()));",
		"cargo test -- 3 tests passed",
		"for i in 0..10 { sum += i; }",
	];
	assert.deepEqual(arithLines(not.join("\n")), []);
});

test("calcSteer names the sample and the way: a program, the checks' values too", () => {
	const s = calcSteer(1, "2_547_500 * 0.25 = 636_875.");
	assert.match(s, /^\[harness\] Your reply was cut: you were computing by hand \("2_547_500 \* 0\.25 = 636_875\."\)/);
	assert.match(s, /python3 -c .*nerd-rs-eval/);
	assert.match(calcSteer(2, "x"), /second time/);
});

function setup(operator = false, tools = ["read", "write", "bash"]) {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	let aborts = 0;
	const sent: string[] = [];
	const pi = {
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		appendEntry: () => {},
		sendUserMessage: (s: string) => sent.push(s),
		getActiveTools: () => tools,
	};
	const g = calcGuard(pi as unknown as Parameters<typeof calcGuard>[0], { operator });
	const ctx = { abort: () => aborts++ };
	const stream = (text: string) => {
		handlers.get("message_start")?.({}, ctx);
		for (let k = 100; k <= text.length + 100; k += 100) handlers.get("message_update")?.({ message: { role: "assistant", content: [{ type: "thinking", thinking: text.slice(0, k) }] } }, ctx);
		handlers.get("message_end")?.({}, ctx);
	};
	return { handlers, g, stream, sent, aborts: () => aborts, ctx };
}

test("the guard cuts a reply of the work at ten hand calculations, at most twice per task", () => {
	const s = setup();
	s.handlers.get("before_agent_start")?.({ prompt: "the task" }, s.ctx);
	s.stream(`Let me check the DK value.\n${HAND.slice(0, 9).join("\n")}\n`);
	assert.equal(s.aborts(), 0, "nine lines are not enough");
	s.stream(`Let me check.\n${HAND.join("\n")}\n`);
	assert.equal(s.aborts(), 1);
	const steer = s.g.takeSteer();
	assert.match(steer ?? "", /computing by hand/);
	assert.equal(s.g.takeSteer(), undefined, "once");
	s.handlers.get("before_agent_start")?.({ prompt: steer }, s.ctx);
	s.stream(HAND.join("\n"));
	assert.equal(s.aborts(), 2, "our own steer does not reset the budget");
	assert.match(s.g.takeSteer() ?? "", /second time/);
	s.stream(HAND.join("\n"));
	assert.equal(s.aborts(), 2, "no third cut");
	s.handlers.get("before_agent_start")?.({ prompt: "a new message of the operator" }, s.ctx);
	s.stream(HAND.join("\n"));
	assert.equal(s.aborts(), 3);
});

test("the guard leaves the plan step alone (no tool to run a program there); the TUI gets the steer sent", () => {
	const plan = setup(false, ["read", "ls"]);
	plan.stream(HAND.join("\n"));
	assert.equal(plan.aborts(), 0);
	const tui = setup(true);
	tui.stream(HAND.join("\n"));
	assert.equal(tui.aborts(), 1);
	assert.equal(tui.sent.length, 1);
	assert.equal(tui.g.takeSteer(), undefined);
});
