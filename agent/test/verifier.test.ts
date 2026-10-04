// Verifier pieces that need no server: score expectation, prompt shape,
// tournament bookkeeping, and the gate that skips identical candidates.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { analysisPart, buildPrompt, expectedScore } from "../src/verifier/pairwise.ts";
import { actionSignature, formatAction, leadingSystemPromptIs } from "../src/verifier/stream.ts";
import { pivotRoundPairs, ringCycle, selectBest } from "../src/verifier/tournament.ts";

const lp = (token: string, p: number) => ({ token, logprob: Math.log(p) });

test("a sharp A is 1, a sharp T is 0, an even split is the midpoint", () => {
	assert.equal(expectedScore([lp(" A", 1)]), 1);
	assert.equal(expectedScore([lp("T", 1)]), 0);
	assert.ok(Math.abs((expectedScore([lp(" A", 0.5), lp(" T", 0.5)]) ?? -1) - 0.5) < 1e-9);
});

test("non-letters are ignored and the letters renormalised", () => {
	// 0.98 on A plus junk: the junk must not dilute the score.
	const s = expectedScore([lp(" A", 0.98), lp("\n", 0.01), lp(" LETTER", 0.01)]);
	assert.ok(Math.abs((s ?? -1) - 1) < 1e-12);
});

test("spellings of one letter are merged by maximum, as in the Python original", () => {
	assert.equal(expectedScore([lp(" A", 0.6), lp("A", 0.2), lp("a", 0.1)]), 1);
});

test("a fused '>A' token (DeepSeek-style) is read as A", () => {
	assert.equal(expectedScore([lp(">A", 1)]), 1);
});

test("no letter at all is undefined, never a silent 0.5", () => {
	assert.equal(expectedScore([lp("\n", 0.7), lp("The", 0.3)]), undefined);
	assert.equal(expectedScore([]), undefined);
});

test("the criterion sits at the tail, after both candidates", () => {
	const p = buildPrompt("TASK", "AAA", "BBB", { name: "Crit", description: "DESC" });
	assert.ok(p.indexOf("TASK") < p.indexOf("AAA"));
	assert.ok(p.indexOf("AAA") < p.indexOf("BBB"));
	assert.ok(p.indexOf("BBB") < p.indexOf("DESC"));
});

test("analysis is cut before the first score tag the model wrote itself", () => {
	assert.equal(analysisPart("looks fine\n<score_A> B </score_A>\n<score_B> C </score_B>"), "looks fine");
	assert.equal(analysisPart("no tags here  "), "no tags here");
});

test("the ring puts every candidate once in each slot", () => {
	const ring = ringCycle(5, () => 0.3);
	assert.equal(ring.length, 5);
	for (let i = 0; i < 5; i++) {
		assert.equal(ring.filter(([a]) => a === i).length, 1);
		assert.equal(ring.filter(([, b]) => b === i).length, 1);
	}
});

test("pivot rounds: every non-pivot meets every pivot, pivots meet each other", () => {
	assert.deepEqual(pivotRoundPairs(4, [2, 0]), [
		[1, 2],
		[1, 0],
		[3, 2],
		[3, 0],
		[0, 2],
	]);
});

test("the tournament finds the candidate the scorer prefers, with N + k(N-k) + C(k,2) comparisons", async () => {
	const quality = [0.2, 0.9, 0.5, 0.1];
	const r = await selectBest(4, async (a, b) => [quality[a], quality[b]], { pivots: 2, random: () => 0.5 });
	assert.equal(r.best, 1);
	assert.equal(r.comparisons.length, 4 + 2 * 2 + 1);
});

test("two candidates: both slot orders, no replay", async () => {
	const r = await selectBest(2, async (a, b) => [a === 1 ? 0.8 : 0.3, b === 1 ? 0.8 : 0.3]);
	assert.equal(r.best, 1);
	assert.equal(r.comparisons.length, 2);
});

function msg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "local",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	} as AssistantMessage;
}

test("same tool calls with different wording need no judging", () => {
	const call = { type: "toolCall" as const, id: "1", name: "bash", arguments: { command: "npm test" } };
	const a = msg([{ type: "text", text: "Let me run the tests." }, call]);
	const b = msg([{ type: "text", text: "Running tests now." }, { ...call, id: "2" }]);
	assert.equal(actionSignature(a), actionSignature(b));
	const c = msg([{ ...call, arguments: { command: "npm test -- --watch" } }]);
	assert.notEqual(actionSignature(a), actionSignature(c));
});

test("an agent step is recognised when Pi puts the prompt into sections, not content", () => {
	const isStep = leadingSystemPromptIs("You are a software engineer");
	const sys = (content: string, sections?: Record<string, string | null>) =>
		({ role: "system", content, sections, timestamp: 0 }) as Message;
	const user = { role: "user", content: "hi", timestamp: 0 } as Message;
	// What the live run showed: empty content, prompt in a section.
	assert.equal(isStep([sys("", { base: "You are a software engineer working alone." }), user]), true);
	assert.equal(isStep([sys("You are a software engineer."), user]), true);
	// A compaction/summary call carries a different prompt.
	assert.equal(isStep([sys("", { base: "Summarize the conversation." }), user]), false);
	assert.equal(isStep([user]), false);
});

test("the stream function skips judging when all candidates are final text", async () => {
	const { verifierStreamFn } = await import("../src/verifier/stream.ts");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const replies = [msg([{ type: "text", text: "Done, all good." }]), msg([{ type: "text", text: "Finished." }])];
	for (const r of replies) r.stopReason = "stop";
	let i = 0;
	const base = (() => {
		const s = createAssistantMessageEventStream();
		const m = replies[i++];
		s.push({ type: "done", reason: "stop", message: m });
		s.end(m);
		return s;
	}) as never;
	// baseUrl points nowhere: a judging attempt would throw and be logged, not pass silently.
	const fn = verifierStreamFn(base, { n: 2, baseUrl: "http://127.0.0.1:1/v1", model: "m" });
	const out = await (await fn({} as never, { messages: [] } as never, undefined)).result();
	assert.equal(i, 2);
	assert.equal(out, replies[0]);
});

test("step kinds: finish, change, check, explore", async () => {
	const { stepKind } = await import("../src/verifier/stream.ts");
	const bash = (command: string) => msg([{ type: "toolCall", id: "1", name: "bash", arguments: { command } }]);
	assert.equal(stepKind(msg([{ type: "text", text: "Done." }])), "finish");
	assert.equal(stepKind(msg([{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.js" } }])), "change");
	assert.equal(stepKind(bash("npm test 2>&1 | tail")), "check");
	assert.equal(stepKind(bash("node fizzbuzz.js")), "check");
	assert.equal(stepKind(bash("node --test")), "check");
	assert.equal(stepKind(bash("curl -s https://en.wikipedia.org/wiki/Wu_xing | head")), "explore");
	assert.equal(stepKind(bash("ls -la && cat package.json")), "explore");
	assert.equal(stepKind(msg([{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.js" } }])), "explore");
});

test("an exploring first candidate is taken without drawing a second", async () => {
	const { verifierStreamFn } = await import("../src/verifier/stream.ts");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	let drawn = 0;
	const base = (() => {
		drawn++;
		const s = createAssistantMessageEventStream();
		const m = msg([{ type: "toolCall", id: String(drawn), name: "bash", arguments: { command: "ls" } }]);
		s.push({ type: "done", reason: "toolUse", message: m });
		s.end(m);
		return s;
	}) as never;
	const fn = verifierStreamFn(base, { n: 3, baseUrl: "http://127.0.0.1:1/v1", model: "m" });
	await (await fn({} as never, { messages: [] } as never, undefined)).result();
	assert.equal(drawn, 1);
});

test("the judge sees text and tool calls", () => {
	const a = msg([
		{ type: "text", text: "Fixing." },
		{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a.js" } },
	]);
	assert.equal(formatAction(a), 'Fixing.\n[tool_call: edit({"path":"a.js"})]');
});
