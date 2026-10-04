// The bash tool's default timeout and its message, and the operator prompt's
// address, against a real bash (no model, no server).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bashTimeout, DEFAULT_BASH_TIMEOUT, nerdBashTool } from "../src/bash-tool.ts";
import { operatorPrompt } from "../src/local.ts";

const cwd = mkdtempSync(join(tmpdir(), "nerd-bash-"));
// The tool reads only cwd and the session id from the context.
const ctx = { cwd, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as never;
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

test("NERD_BASH_TIMEOUT sets the default; junk falls back to 600", () => {
	assert.equal(DEFAULT_BASH_TIMEOUT, 600);
	assert.equal(bashTimeout({}), 600);
	assert.equal(bashTimeout({ NERD_BASH_TIMEOUT: "30" }), 30);
	assert.equal(bashTimeout({ NERD_BASH_TIMEOUT: "0" }), 600);
	assert.equal(bashTimeout({ NERD_BASH_TIMEOUT: "soon" }), 600);
});

test("it is Pi's bash tool by name, with the default in the schema", () => {
	const t = nerdBashTool(cwd, 7);
	assert.equal(t.name, "bash");
	assert.match((t.parameters.properties.timeout as { description?: string }).description ?? "", /default 7\b/);
	assert.match(t.description, /time out after 7 s/);
});

test("a quick command runs as before", async () => {
	const r = await nerdBashTool(cwd, 5).execute("1", { command: "echo hi" }, undefined, undefined, ctx);
	assert.equal(text(r).trim(), "hi");
});

test("a foreground command without a timeout is cut at the default, with a plain message", async () => {
	const t0 = Date.now();
	await assert.rejects(
		nerdBashTool(cwd, 1).execute("2", { command: "echo started; sleep 30" }, undefined, undefined, ctx),
		(e: Error) => {
			assert.match(e.message, /^started\n/);
			assert.match(e.message, /did not return within 1 s/);
			assert.match(e.message, /detached/);
			assert.match(e.message, /output to a file/);
			return true;
		},
	);
	assert.ok(Date.now() - t0 < 10_000, "returned long before the sleep ended");
});

test("the model's own timeout wins over the default", async () => {
	await assert.rejects(
		nerdBashTool(cwd, 600).execute("3", { command: "sleep 30", timeout: 1 }, undefined, undefined, ctx),
		/did not return within 1 s/,
	);
});

test("other failures pass through unchanged", async () => {
	// Since Pi 0.99 a non-zero exit is an error result, not a thrown error.
	const r = await nerdBashTool(cwd, 5).execute("4", { command: "exit 3" }, undefined, undefined, ctx);
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(text(r), /Command exited with code 3/);
});

test("NERD_OPERATOR_URL is stated as a fact; the check-it habit stays", () => {
	const p = operatorPrompt("8000", "http://example.test:8000");
	assert.ok(p.includes("The operator reaches the app at http://example.test:8000."));
	assert.ok(p.includes("check it the way they will use it"));
	// Questions and the plan are the harness's step now (ticket 043), not prompt text.
	assert.ok(!/ask about them|plan into a file/.test(p));
	assert.ok(!operatorPrompt("8000", undefined).includes("reaches the app"));
});
