// Anchors after a compaction (anchors.ts, ticket 057 of the process): the task,
// PLAN.md, notes/ and the changed files, within the budget, as one message.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { anchors, anchorsMax, anchorsOn, anchorText, changedFiles, DEFAULT_ANCHORS_MAX, notesIndex } from "../src/anchors.ts";
import { tempDir } from "./tmp.ts";

function repo(): string {
	const d = tempDir("nerd-anchors-");
	const g = (...a: string[]) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
	g("init", "-q");
	g("config", "user.name", "t");
	g("config", "user.email", "t@t");
	writeFileSync(join(d, "PLAN.md"), "# Plan\n1. elements module — check: unit tests\n2. server — check: curl\n");
	g("add", ".");
	g("commit", "-qm", "Plan");
	mkdirSync(join(d, "notes"));
	writeFileSync(join(d, "notes", "wuxing.md"), "# Wu xing cycles — https://en.wikipedia.org/wiki/Wuxing_(Chinese_philosophy)\n");
	writeFileSync(join(d, "server.js"), "// server\n");
	return d;
}

test("anchors: on unless NERD_ANCHORS=0; 4000 characters unless NERD_ANCHORS_MAX_CHARS", () => {
	assert.equal(anchorsOn({}), true);
	assert.equal(anchorsOn({ NERD_ANCHORS: "0" }), false);
	assert.equal(anchorsMax({}), DEFAULT_ANCHORS_MAX);
	assert.equal(anchorsMax({ NERD_ANCHORS_MAX_CHARS: "2000" }), 2000);
});

test("anchors: task, latest remark, PLAN.md, notes/ index and changed files", () => {
	const d = repo();
	assert.deepEqual(notesIndex(d), ["notes/wuxing.md — Wu xing cycles — https://en.wikipedia.org/wiki/Wuxing_(Chinese_philosophy)"]);
	assert.deepEqual(changedFiles(d, "2000-01-01T00:00:00Z"), ["PLAN.md", "notes/wuxing.md", "server.js"]);
	const t = anchorText({ cwd: d, task: "Хочу web-игру у-син", latest: "Сделай удобно на телефоне", sinceIso: "2000-01-01T00:00:00Z", max: 4000 });
	assert.ok(t);
	assert.match(t, /^\[harness\] The conversation was just compacted/);
	assert.match(t, /operator's words:\nХочу web-игру у-син/);
	assert.match(t, /latest message:\nСделай удобно на телефоне/);
	assert.match(t, /PLAN\.md:\n# Plan\n1\. elements module/);
	assert.match(t, /notes\/wuxing\.md — Wu xing cycles/);
	assert.match(t, /Files changed since the task began:\nPLAN\.md\nnotes\/wuxing\.md\nserver\.js/);
});

test("anchors: everything is cut to the budget; nothing to say gives nothing", () => {
	const d = repo();
	writeFileSync(join(d, "PLAN.md"), `# Plan\n${"step — check: run it\n".repeat(500)}`);
	const t = anchorText({ cwd: d, task: "x".repeat(5000), max: 1500 });
	assert.ok(t && t.length <= 1500, `within the budget (${t?.length})`);
	assert.equal(anchorText({ cwd: tempDir("nerd-anchors-empty-"), max: 4000 }), undefined);
});

test("anchors: after a compaction one message goes to the model, steered while it works", () => {
	const d = repo();
	const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
	const sent: { message: { customType: string; content: string }; options: { deliverAs: string } }[] = [];
	const pi = {
		on: (name: string, h: (e: unknown, ctx: unknown) => void) => {
			handlers[name] = h;
		},
		sendMessage: (message: { customType: string; content: string }, options: { deliverAs: string }) => sent.push({ message, options }),
	};
	anchors(pi as never, {});
	const branch = [
		{ type: "message", timestamp: "2000-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "the task" }] } },
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "compaction" },
	];
	const ctx = (idle: boolean) => ({ cwd: d, isIdle: () => idle, sessionManager: { getBranch: () => branch } });
	handlers.session_compact({}, ctx(false));
	handlers.session_compact({}, ctx(true));
	assert.equal(sent.length, 2);
	assert.equal(sent[0].message.customType, "nerd-anchors");
	assert.match(sent[0].message.content, /operator's words:\nthe task/);
	assert.doesNotMatch(sent[0].message.content, /latest message/, "one operator message: no separate latest");
	assert.equal(sent[0].options.deliverAs, "steer");
	assert.equal(sent[1].options.deliverAs, "nextTurn");
});

test("anchors: PLAN.md as the plan step writes it gives questions with answers, steps and done-when; no task quote, no assumptions", () => {
	const d = repo();
	writeFileSync(
		join(d, "PLAN.md"),
		[
			"# Plan",
			"",
			"## Task",
			"",
			"> Хочу web-игру у-син",
			"",
			"## Assumptions",
			"",
			"- ASSUMED-THING",
			"",
			"## Questions",
			"",
			"- Сколько рангов ботов?",
			"- Раунды до N побед?",
			"",
			"Answer: 1. Уровней ботов — минимум три. 2. Раунды — до трёх побед.",
			"",
			"## Steps",
			"",
			"1. elements module — check: unit tests",
			"2. server — check: curl",
			"",
			"## Done when",
			"",
			"- the operator plays a bot match",
			"",
		].join("\n"),
	);
	const answer = "1. Уровней ботов — минимум три. 2. Раунды — до трёх побед.";
	const t = anchorText({ cwd: d, task: "Хочу web-игру у-син", latest: answer, max: 4000 });
	assert.ok(t);
	assert.match(t, /- Сколько рангов ботов\? — Уровней ботов — минимум три\./);
	assert.match(t, /- Раунды до N побед\? — Раунды — до трёх побед\./);
	assert.match(t, /Steps:\n1\. elements module — check: unit tests\n2\. server/);
	assert.match(t, /Done when:\n- the operator plays a bot match/);
	assert.doesNotMatch(t, /ASSUMED-THING/);
	assert.doesNotMatch(t, /> Хочу/, "the task quote of PLAN.md is not repeated");
	assert.doesNotMatch(t, /latest message/, "bare answers are not repeated as the latest message");
	const r = anchorText({ cwd: d, task: "Хочу web-игру у-син", latest: "Сделай удобно на телефоне", max: 4000 });
	assert.match(r ?? "", /latest message:\nСделай удобно на телефоне/, "a remark still comes as the latest message");
});
