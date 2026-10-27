// pi-vcc's cut with nerd's patch (patches/apply.mjs, process ticket 057). Pi records the
// system prompt as a message entry, so within the task's one turn the task is not the first
// live message: pi-vcc kept that whole user turn and summarized only the system message —
// a compaction that freed nothing, and the next one came a call later (96 of 124 such
// back-to-back compactions of Bonsai's runs). Patched: only system messages before the
// last user message is no anchor, and the tail is cut to pi-vcc's budget, as when the
// task is first.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const agent = join(import.meta.dirname, "..");
// pi-vcc ships TypeScript that Pi loads with its own jiti; the test does the same.
const require = createRequire(join(agent, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(join(agent, "package.json"), { fsCache: false });
const vcc = await jiti.import(join(agent, "node_modules/@sting8k/pi-vcc/src/hooks/before-compact.ts"));

let id = 0;
const message = (role: string, content: unknown) => ({ type: "message", id: `e${id++}`, message: { role, content, timestamp: 0 } });
const system = () => message("system", [{ type: "text", text: "You are a software engineer." }]);
const user = (text: string) => message("user", [{ type: "text", text }]);
/** One write of `chars` characters and its result: about chars/4 tokens. */
const work = (chars: number) => [
	message("assistant", [{ type: "toolCall", id: `c${id}`, name: "write", arguments: { path: "f.txt", content: "x".repeat(chars) } }]),
	message("toolResult", [{ type: "text", text: "Wrote f.txt" }]),
];
const cut = (entries: unknown[]) => vcc.applyTailBudget(entries, vcc.buildOwnCut(entries, 1), { charsPerToken: 4 });

test("pi-vcc patch: a system message before the task is no anchor — the task's turn is cut to the budget", () => {
	// ~40K tokens of work in the task's turn: over pi-vcc's 25K budget, under its 62.5K "oversized" mark
	const entries = [system(), user("Make the project"), ...work(40_000), ...work(40_000), ...work(40_000), ...work(40_000)];
	const c = cut(entries);
	assert.equal(c.ok, true);
	assert.equal(c.budgetCut, "no_anchor");
	assert.ok(c.messages.length > 2, `more than the system message is summarized (${c.messages.length})`);
	const kept = entries.slice(entries.findIndex((e) => e.id === c.firstKeptEntryId));
	assert.ok(kept.length < entries.length - 2, "the kept tail is shorter than the whole turn");
});

test("pi-vcc patch: the same with the task first (no system message) was already cut to the budget", () => {
	const entries = [user("Make the project"), ...work(40_000), ...work(40_000), ...work(40_000), ...work(40_000)];
	const c = cut(entries);
	assert.equal(c.budgetCut, "no_anchor");
});

test("pi-vcc patch: a later operator message is still the anchor — its turn is kept whole", () => {
	const later = user("And now the README");
	const entries = [system(), user("Make the project"), ...work(40_000), later, ...work(40_000)];
	const c = cut(entries);
	assert.equal(c.budgetCut, undefined);
	assert.equal(c.compactAll, false);
	assert.equal(c.firstKeptEntryId, later.id);
});
