// #1051: the reflex by place of work — notes naming an edited file, shown once, forgotten a few turns later.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildIndex, forgetReflex, REFLEX_HEAD, reflexExtension, reflexNote } from "../src/reflex.ts";
import { tempDir } from "./tmp.ts";

function workspace() {
	const d = tempDir("nerd-reflex-");
	mkdirSync(join(d, "notes"));
	mkdirSync(join(d, "docs"));
	writeFileSync(join(d, "notes", "decisions.md"), "# Decisions\n\n- damage.rs keeps quarter units; never round there (found by §10.13).\n- unrelated line\n");
	writeFileSync(join(d, "docs", "SERVER.md"), "## 13. Persistence\nThe log is written by store.rs and replayed by damage.rs on restart.\n");
	writeFileSync(join(d, "PLAN.md"), "1. fix damage.rs\n");
	writeFileSync(join(d, "README.md"), "see main.rs and damage.rs\n");
	return d;
}

test("reflex: the notes naming the edited file, with their lines; PLAN.md and common names left out", () => {
	const d = workspace();
	const index = buildIndex(d);
	const done = new Set<string>();
	const note = reflexNote(index, "wxd-core/src/damage.rs", done) ?? "";
	assert.match(note, new RegExp(`^\\${REFLEX_HEAD.slice(0, 8)}`));
	assert.match(note, /notes\/decisions\.md: - damage\.rs keeps quarter units/);
	assert.match(note, /docs\/SERVER\.md: The log is written by store\.rs and replayed by damage\.rs/);
	assert.match(note, /README\.md/, "a README naming the file is a note like any other");
	assert.doesNotMatch(note, /PLAN\.md/, "the plan is re-read anyway");
	assert.equal(reflexNote(index, "wxd-core/src/damage.rs", done), undefined, "once per note");
	assert.equal(reflexNote(index, "src/main.rs", new Set()), undefined, "too common a name to mean one file");
	assert.equal(reflexNote(index, "src/other.rs", new Set()), undefined, "no note names it");
});

test("reflex: a note already read is not shown; the edited note itself is not shown", () => {
	const d = workspace();
	const index = buildIndex(d);
	const note = reflexNote(index, "src/damage.rs", new Set(["notes/decisions.md"])) ?? "";
	assert.doesNotMatch(note, /decisions\.md/);
	assert.match(note, /SERVER\.md/);
	assert.equal(reflexNote(buildIndex(d), "docs/SERVER.md", new Set()), undefined);
});

test("forgetReflex: the reflex text leaves tool results older than `keep` assistant turns, the rest stays", () => {
	const tr = (t: string) => ({ role: "toolResult", content: [{ type: "text", text: t }] });
	const as = { role: "assistant", content: [{ type: "text", text: "ok" }] };
	const msgs = [tr(`edited\n\n${REFLEX_HEAD} (damage.rs) — …\n- notes/x.md: …`), as, tr("ran"), as, tr(`edited 2\n\n${REFLEX_HEAD} (b.rs)`), as];
	const out = forgetReflex(msgs, 2) as typeof msgs;
	assert.equal(out[0].content[0].text, "edited", "3 turns old: cut");
	assert.match(out[4].content[0].text, /\[reflex\]/, "1 turn old: kept");
	assert.equal(forgetReflex(out, 2), out, "nothing more to cut: the same array (no needless change of the context)");
	assert.equal(msgs[0].content[0].text.includes(REFLEX_HEAD), true, "the session's own messages are not changed");
});

test("reflexExtension: an edit's result gets the note; a read marks the note seen; context forgets it", () => {
	const d = workspace();
	const handlers = new Map<string, (e: any, c: any) => any>();
	const entries: unknown[] = [];
	const pi = { on: (n: string, h: (e: any, c: any) => any) => handlers.set(n, h), appendEntry: (_t: string, x: unknown) => entries.push(x) };
	reflexExtension(pi as never, { keep: 1, root: d });
	const ctx = { cwd: d };
	handlers.get("session_start")?.({}, ctx);
	handlers.get("tool_result")?.({ toolName: "read", input: { path: join(d, "docs/SERVER.md") }, content: [], isError: false }, ctx);
	const r = handlers.get("tool_result")?.({ toolName: "edit", input: { path: "src/damage.rs" }, content: [{ type: "text", text: "Edited." }], isError: false }, ctx);
	const text = r.content.map((b: { text: string }) => b.text).join("");
	assert.match(text, /decisions\.md/);
	assert.doesNotMatch(text, /SERVER\.md/, "read before: no news");
	assert.equal(entries.length, 1);
	assert.equal(handlers.get("tool_result")?.({ toolName: "edit", input: { path: "src/damage.rs" }, content: [], isError: false }, ctx), undefined, "shown once");
	handlers.get("session_compact")?.({}, ctx);
	assert.ok(handlers.get("tool_result")?.({ toolName: "edit", input: { path: "src/damage.rs" }, content: [], isError: false }, ctx), "a compaction starts the count again");
	const later = handlers.get("context")?.({ messages: [{ role: "toolResult", content: [{ type: "text", text: text }] }, { role: "assistant", content: [] }, { role: "assistant", content: [] }] }, ctx);
	assert.equal(later.messages[0].content[0].text, "Edited.");
});
