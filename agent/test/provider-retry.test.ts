// Process ticket 110: a reply a cloud provider broke off with finish_reason "error"
// (HTTP 200, then the stream ends so) is retried like a 5xx, in a real headless Pi
// session against a server that breaks the first reply off and answers the second.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { headlessSession } from "../src/headless.ts";
import { modelDefinition, providerBreak, settingsFor, widenRetry } from "../src/local.ts";
import { tempDir } from "./tmp.ts";

test("providerBreak: finish_reason error, not other errors", () => {
	assert.ok(providerBreak({ stopReason: "error", errorMessage: "Provider finish_reason: error" }));
	assert.ok(!providerBreak({ stopReason: "error", errorMessage: "context length exceeded" }));
	assert.ok(!providerBreak({ stopReason: "stop", errorMessage: "Provider finish_reason: error" }));
});

test("widenRetry: Pi's AgentSession still has the method it wraps", () => {
	// A Pi bump that renames it turns the retry off quietly; this makes it loud.
	assert.equal(typeof (AgentSession.prototype as unknown as { _isRetryableError?: unknown })._isRetryableError, "function");
	assert.equal(widenRetry({}), false);
	const s = { _isRetryableError: (m: { errorMessage?: string }) => m.errorMessage === "overloaded" };
	assert.ok(widenRetry(s));
	assert.ok(s._isRetryableError({ stopReason: "error", errorMessage: "overloaded" } as never));
	assert.ok(s._isRetryableError({ stopReason: "error", errorMessage: "Provider finish_reason: error" } as never));
	assert.ok(!s._isRetryableError({ stopReason: "error", errorMessage: "bad request" } as never));
});

test("a headless session retries a reply the provider broke off, and gets the answer", async () => {
	let calls = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			calls += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null) =>
				res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			if (calls === 1) {
				chunk({ role: "assistant", content: "Let me" }, null);
				chunk({}, "error");
			} else {
				chunk({ role: "assistant", content: "Answered." }, null);
				chunk({}, "stop");
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	const agentDir = tempDir("nerd-retry-agent-");
	const local = { baseUrl, id: "fake", ctx: 32768, thinking: "off" as const, verifyN: 1 };
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl, api: "openai-completions", apiKey: "none", models: [modelDefinition(local)] } } }),
	);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const session = await headlessSession({
		cwd: tempDir("nerd-retry-ws-"),
		agentDir,
		model: modelRuntime.getModel("local", "fake")!,
		modelRuntime,
		thinking: "off",
		settings: { ...settingsFor(local), retry: { enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 50 } },
		extensions: [],
		env: { NERD_RUNS: "0" },
	});
	try {
		await session.prompt("say something");
		const last = session.messages.at(-1) as { role?: string; stopReason?: string; content?: { text?: string }[] };
		assert.equal(calls, 2, "the broken reply was asked again");
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "stop");
		assert.match((last.content ?? []).map((c) => c.text ?? "").join(""), /Answered/);
	} finally {
		session.dispose();
		server.close();
	}
});
