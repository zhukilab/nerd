// The model's thinking of earlier steps left out of the request (thinking-keep.ts, process
// ticket 057): NERD_THINKING_KEEP=N keeps the thinking of the last N replies that have any.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dropOldThinking, thinkingKeep } from "../src/thinking-keep.ts";

const reply = (n: number, call = true) => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: `thought ${n}` },
		...(call ? [{ type: "toolCall", id: `c${n}`, name: "bash", arguments: { command: `step ${n}` } }] : [{ type: "text", text: `answer ${n}` }]),
	],
});
const result = (n: number) => ({ role: "toolResult", toolCallId: `c${n}`, content: [{ type: "text", text: `out ${n}` }] });
const thoughts = (msgs: unknown[]) =>
	(msgs as { content?: { type: string; thinking?: string }[] }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "thinking").map((b) => b.thinking));

test("thinking keep: 0 by default; a whole number; 'all' turns it off", () => {
	assert.equal(thinkingKeep({}), 0);
	assert.equal(thinkingKeep({ NERD_THINKING_KEEP: "" }), 0);
	assert.equal(thinkingKeep({ NERD_THINKING_KEEP: "x" }), 0);
	assert.equal(thinkingKeep({ NERD_THINKING_KEEP: "-1" }), 0);
	assert.equal(thinkingKeep({ NERD_THINKING_KEEP: "2" }), 2);
	assert.equal(thinkingKeep({ NERD_THINKING_KEEP: "all" }), undefined);
});

test("thinking keep: N=2 keeps the last two replies' thinking; the rest of each reply stays", () => {
	const msgs = [{ role: "user", content: "task" }, reply(1), result(1), reply(2), result(2), reply(3), result(3), reply(4), result(4)];
	const out = dropOldThinking(msgs, 2);
	assert.deepEqual(thoughts(out), ["thought 3", "thought 4"]);
	assert.equal(out.length, msgs.length, "no message goes");
	assert.deepEqual((out[1] as { content: unknown[] }).content, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "step 1" } }]);
	assert.deepEqual(thoughts(msgs), ["thought 1", "thought 2", "thought 3", "thought 4"], "the input is not changed");
});

test("thinking keep: N=0 keeps none; replies without thinking do not count", () => {
	const plain = { role: "assistant", content: [{ type: "text", text: "no thinking here" }] };
	const msgs = [reply(1), result(1), reply(2), result(2), plain, reply(3, false)];
	assert.deepEqual(thoughts(dropOldThinking(msgs, 0)), []);
	assert.deepEqual(thoughts(dropOldThinking(msgs, 1)), ["thought 3"], "the plain reply is not one of the last N");
	assert.equal(dropOldThinking(msgs, 3), msgs, "nothing to drop: the same array");
});
