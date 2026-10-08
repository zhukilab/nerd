// The operator's rules (rules.ts, process ticket 061) and the compaction
// summary's goal (summary-goal.ts): the file, the commands, the prompt
// section and its cap, the rewrite of pi-vcc's summary.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { forget, readRules, remember, rules, rulesMax, rulesPath, rulesPrompt, writeRules } from "../src/rules.ts";
import { fixSummary } from "../src/summary-goal.ts";
import { tempDir } from "./tmp.ts";

test("rules: the file is in Pi's agent dir unless NERD_RULES_FILE; the cap is 4000 unless NERD_RULES_MAX_CHARS", () => {
	assert.equal(rulesPath({ PI_CODING_AGENT_DIR: "/h/.pi/nerd" }), "/h/.pi/nerd/RULES.md");
	assert.equal(rulesPath({ NERD_RULES_FILE: "/x/r.md", PI_CODING_AGENT_DIR: "/h" }), "/x/r.md");
	assert.equal(rulesMax({}), 4000);
	assert.equal(rulesMax({ NERD_RULES_MAX_CHARS: "500" }), 500);
	assert.equal(rulesMax({ NERD_RULES_MAX_CHARS: "junk" }), 4000);
});

test("rules: remember numbers them, forget drops by number or by text, the rest is renumbered", () => {
	const f = join(tempDir("nerd-rules-"), "sub", "RULES.md");
	assert.deepEqual(readRules(f), [], "no file: no rules");
	assert.equal(remember(f, "  commits   in English "), 1);
	assert.equal(remember(f, "README has a 'How to check' section"), 2);
	assert.equal(remember(f, "port 8123 by default"), 3);
	assert.deepEqual(readRules(f), ["commits in English", "README has a 'How to check' section", "port 8123 by default"]);
	assert.equal(forget(f, "2"), "README has a 'How to check' section");
	assert.equal(forget(f, "PORT"), "port 8123 by default", "by text, any case");
	assert.equal(forget(f, "9"), undefined);
	assert.equal(forget(f, "nothing like it"), undefined);
	assert.equal(forget(f, " "), undefined);
	assert.match(readFileSync(f, "utf8"), /^# .*\n\n1\. commits in English\n$/);
});

test("rules: a hand-edited file with bullets is read too; other lines are not rules", () => {
	const f = join(tempDir("nerd-rules-"), "RULES.md");
	writeRules(f, []);
	assert.deepEqual(readRules(f), []);
	const text = "# mine\n- one\n* two\n3) three\nsome note\n";
	writeFileSync(f, text);
	assert.deepEqual(readRules(f), ["one", "two", "three"]);
});

test("rules: the prompt section lists them; what does not fit is named, not dropped silently", () => {
	assert.equal(rulesPrompt([]), undefined);
	const s = rulesPrompt(["a", "b"])!;
	assert.match(s, /^## The operator's rules\n.*\n1\. a\n2\. b$/);
	const long = Array.from({ length: 50 }, (_, i) => `rule number ${i} ${"x".repeat(80)}`);
	const cut = rulesPrompt(long, 1000)!;
	assert.ok(cut.length < 1200);
	assert.match(cut, /\(\d+ more rule\(s\) did not fit in 1000 characters/);
});

test("rules: /remember, /forget and /rules work on the file and tell the operator", async () => {
	const f = join(tempDir("nerd-rules-"), "RULES.md");
	const cmds: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const notes: [string, string][] = [];
	const pi = { on() {}, registerCommand: (name: string, def: (typeof cmds)[string]) => (cmds[name] = def) };
	rules(pi as never, { NERD_RULES_FILE: f });
	const ctx = { ui: { notify: (m: string, kind: string) => notes.push([m, kind]) } };
	assert.deepEqual(Object.keys(cmds).sort(), ["forget", "remember", "rules"]);
	await cmds.rules.handler("", ctx);
	assert.match(notes.at(-1)![0], /no rules yet/);
	await cmds.remember.handler("", ctx);
	assert.equal(notes.at(-1)![1], "error");
	await cmds.remember.handler("English commit messages", ctx);
	assert.match(notes.at(-1)![0], /rule 1 kept/);
	await cmds.rules.handler("", ctx);
	assert.match(notes.at(-1)![0], /1\. English commit messages/);
	await cmds.forget.handler("7", ctx);
	assert.equal(notes.at(-1)![1], "error");
	await cmds.forget.handler("1", ctx);
	assert.match(notes.at(-1)![0], /dropped: English commit messages/);
	assert.deepEqual(readRules(f), []);
});

const PI_VCC = `[Session Goal]
- Reply in exactly this form:
- ASSUMPTIONS
- <each choice the request leaves open>
- На твоё усмотрение. 2. Двое.

[Files And Changes]
- Modified: game.js

---

Use \`vcc_recall\` to search for prior work, decisions, and context from before this summary. Do not redo work already
completed.

[assistant]
* write "game.js"`;

test("summary goal: pi-vcc's goal becomes the task; the plan form and old answers go; the vcc_recall hint goes unless offered", () => {
	const out = fixSummary(PI_VCC, "Хочу web-игру у-син\nна Node.js", false);
	assert.match(out, /^\[Session Goal\]\n- The task, in the operator's words: Хочу web-игру у-син на Node\.js\n- Decisions, answers and steps: PLAN\.md/);
	assert.doesNotMatch(out, /Reply in exactly this form|ASSUMPTIONS|На твоё усмотрение/);
	assert.match(out, /\[Files And Changes\]\n- Modified: game\.js/);
	assert.doesNotMatch(out, /vcc_recall/);
	assert.doesNotMatch(out, /Do not redo|^completed\.$/m, "the whole hint paragraph goes");
	assert.match(out, /---\n\n\[assistant\]\n\* write "game\.js"/, "and nothing after it");
	assert.match(fixSummary(PI_VCC, "t", true), /vcc_recall/, "kept when the tool is offered");
	assert.equal(fixSummary("[Files]\n- x\n", undefined, true), "[Files]\n- x\n", "no task: as it was");
	assert.match(fixSummary("[Files]\n- x\n", "do it", true), /^\[Session Goal\]\n- The task, in the operator's words: do it\n.*\n\n\[Files\]/);
	assert.equal(fixSummary(PI_VCC, "t", false), fixSummary(PI_VCC, "t", false), "the same every time: the prefix cache holds");
	assert.match(fixSummary(PI_VCC, "y".repeat(2000), false), /y{1200} \[…\]/);
});

test("summary goal: the plan step's form and the model's ASSUMPTIONS go from the transcript too; the rest stays", () => {
	const transcript = `[user]
Хочу игру
[harness] A new task. This turn is for questions and a plan only.
Reply in exactly this form:
ASSUMPTIONS
- <each choice the request leaves open>
QUESTIONS
- <a short question>

[assistant]
ASSUMPTIONS
- water beats wood
- fire beats wood
PLAN
1. write game.js — check: node --test
DONE WHEN
- it runs
`;
	const out = fixSummary(transcript, undefined, true);
	assert.doesNotMatch(out, /Reply in exactly this form|ASSUMPTIONS|water beats wood|<each choice/);
	assert.match(out, /\(assumptions made before the operator's answers left out: PLAN\.md has the decisions\)\nPLAN\n1\. write game\.js/);
	assert.match(out, /QUESTIONS\n- <a short question>/, "only the assumptions block goes");
	assert.match(out, /DONE WHEN\n- it runs/);
});
