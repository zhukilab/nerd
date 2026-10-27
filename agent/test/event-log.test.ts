// The events log keeps a streamed update's delta, not the whole message so far (process ticket 089).
import assert from "node:assert/strict";
import { test } from "node:test";
import { logged } from "../src/event-log.ts";

test("event log: an update keeps its delta only; other events as they are", () => {
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(10_000) }] };
	const update = { type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "y", partial: message } };
	assert.deepEqual(logged(update), { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "y" } });
	assert.ok(JSON.stringify(logged(update)).length < 120);
	const end = { type: "message_end", message };
	assert.equal(logged(end), end);
});
