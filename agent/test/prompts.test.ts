// The prompt audit's fixes (ticket 059 of the process): the web guidance in our
// own system prompt, fetched pages kept in notes/web/ by the harness, web_search
// without its `provider` parameter, the bash description that says what the
// tool does, and the port line that agrees with the done gate.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bashDescription, timeoutMessage } from "../src/bash-tool.ts";
import { operatorPrompt, SYSTEM_PROMPT, systemPrompt, WEB_PROMPT } from "../src/local.ts";
import { stripProviderParam, webToolsConfig } from "../src/packages.ts";
import { saveWebNote, webNoteName, webNotes, webNotesOn } from "../src/web-notes.ts";
import { tempDir } from "./tmp.ts";

test("prompts: the web lines are in the system prompt when the web tools are on, and only then", () => {
	assert.equal(systemPrompt(false), SYSTEM_PROMPT);
	const p = systemPrompt(true);
	assert.ok(p.startsWith(SYSTEM_PROMPT) && p.endsWith(WEB_PROMPT));
	assert.match(p, /web_search, then web_fetch/);
	assert.match(p, /show to the user \(in the README or on the page\) as the source states them, with its URL/);
	assert.doesNotMatch(SYSTEM_PROMPT, /Tools: read, bash, edit, write/, "no tools line that is wrong in the plan turn");
	assert.deepEqual(webToolsConfig(), { provider: "searxng" }, "no guidance lines Pi would drop anyway");
});

test("prompts: the port line says to listen on process.env.PORT", () => {
	assert.match(operatorPrompt("8000", undefined), /served on port 8000: listen on `process\.env\.PORT \|\| 8000`/);
	assert.doesNotMatch(operatorPrompt(undefined, undefined), /PORT/);
});

test("prompts: bash says how long output is really cut; the timeout message covers client scripts", () => {
	const pi =
		"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
	const d = bashDescription(pi, 600, {});
	assert.match(d, /Output over 8000 characters is cut to its first and last lines/);
	assert.match(d, /time out after 600 s/);
	assert.doesNotMatch(d, /2000 lines|50KB/);
	assert.match(bashDescription(pi, 600, { NERD_BASH_MAX_CHARS: "0" }), /2000 lines or 50KB/, "with the cap off Pi's own words stand");
	assert.match(timeoutMessage(600), /client script .* must close its connection and exit/);
});

test("prompts: web_search's provider parameter is cut from a request, without touching the declaration it came from", () => {
	const decl = { name: "web_search", parameters: { type: "object", properties: { query: { type: "string" }, provider: { type: "string" } }, required: ["query"] } };
	const payload = { model: "m", tools: [{ type: "function", function: decl }, { type: "function", function: { name: "read", parameters: { properties: { path: {} } } } }] };
	const out = stripProviderParam(payload) as { tools: { function: { parameters: { properties: object; required?: string[] } } }[] };
	assert.ok(out);
	assert.deepEqual(Object.keys(out.tools[0].function.parameters.properties), ["query"]);
	assert.deepEqual(out.tools[0].function.parameters.required, ["query"]);
	assert.ok("provider" in decl.parameters.properties, "the tool's own schema is left as it was");
	assert.equal(out.tools[1], payload.tools[1]);
	assert.equal(stripProviderParam(out), undefined, "nothing to drop: no new payload");
	assert.equal(stripProviderParam({ messages: [] }), undefined);
});

test("web notes: a fetched page goes to notes/web/<host-path>.md with its URL; the model is told where", () => {
	assert.equal(webNotesOn({}), true);
	assert.equal(webNotesOn({ NERD_WEB_NOTES: "0" }), false);
	assert.equal(webNoteName("https://en.wikipedia.org/wiki/Wuxing_(Chinese_philosophy)#Cycles"), "en-wikipedia-org-wiki-wuxing-chinese-philosophy.md");
	const d = tempDir("nerd-webnotes-");
	const rel = saveWebNote(d, "https://example.org/a", "Wood feeds Fire", "2026-10-08T00:00:00Z");
	assert.equal(rel, "notes/web/example-org-a.md");
	assert.equal(readFileSync(join(d, rel), "utf8"), "# https://example.org/a\n\nURL: https://example.org/a\nFetched: 2026-10-08T00:00:00Z\n\nWood feeds Fire\n");

	// As an extension: the whole page from web_fetch's spill file, a note on the result.
	let handler: ((e: unknown, ctx: unknown) => unknown) | undefined;
	webNotes({ on: (_: string, h: (e: unknown, ctx: unknown) => unknown) => (handler = h) } as never);
	const full = join(d, "full.txt");
	writeFileSync(full, "Wood feeds Fire. Fire makes Earth. Earth bears Metal. Metal carries Water. Water nourishes Wood.");
	const r = handler?.(
		{ toolName: "web_fetch", isError: false, input: { url: "https://example.org/wuxing" }, content: [{ type: "text", text: "Wood feeds Fire… [Content truncated]" }], details: { fullOutputPath: full } },
		{ cwd: d },
	) as { content: { text: string }[] };
	const note = readFileSync(join(d, "notes/web/example-org-wuxing.md"), "utf8");
	assert.match(note, /Water nourishes Wood\./, "the whole page, not the cut one");
	assert.match(r.content.at(-1)?.text ?? "", /saved in notes\/web\/example-org-wuxing\.md/);
	assert.equal(handler?.({ toolName: "web_fetch", isError: true, input: { url: "https://example.org/x" }, content: [] }, { cwd: d }), undefined);
	assert.ok(!existsSync(join(d, "notes/web/example-org-x.md")), "a failed fetch leaves no note");
});
