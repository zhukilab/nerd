// #993: the session's statistics — tokens, context peak, the server's timings, MTP, tools — and the
// summary line and status line made from them; then run.ts end to end against a server that sends
// llama-server's `timings` in its last chunk.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionStats } from "../src/session-stats.ts";
import { tempDir } from "./tmp.ts";

test("SessionStats: tokens, peak, the server's timings and MTP, tools; the summary and the status line", () => {
	let now = Date.parse("2026-11-21T20:00:00Z");
	const st = new SessionStats(() => now);
	st.session = "s1";
	st.model = "bonsai2-q1";
	st.context(41_000, 262_144);
	st.context(198_000, 262_144);
	st.context(41_000, 262_144);
	st.reply({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
	st.reply({ input: 500, output: 50 });
	st.chunk({ choices: [] }); // no timings: not a reply of the server's
	st.chunk({ timings: { prompt_n: 1000, prompt_ms: 2000, predicted_n: 100, predicted_ms: 5000, cache_n: 3000, draft_n: 80, draft_n_accepted: 60 } });
	st.chunk({ timings: { prompt_n: 500, prompt_ms: 1000, predicted_n: 50, predicted_ms: 2000, cache_n: 0, draft_n: 20, draft_n_accepted: 10 } });
	st.toolStart("a");
	now += 4000;
	st.toolEnd("a");
	st.toolEnd("never-started");
	now += 16_000; // 20 s of wall time in all
	const s = st.summary(true, { end: "finished", exit: 0 });
	assert.equal(s.type, "session_summary");
	assert.equal(s.v, 1);
	assert.equal(s.ts, "2026-11-21T20:00:20.000Z");
	assert.equal(s.complete, true);
	assert.equal(s.session, "s1");
	assert.deepEqual(s.tokens, { in: 1500, out: 150, cache_read: 0, cache_write: 0, server_cache_n: 3000, hit_ratio: 0.667 });
	assert.deepEqual(s.ctx, { peak: 198_000, window: 262_144 });
	assert.deepEqual(s.model_s, { prompt: 3, gen: 7 });
	assert.equal(s.tool_s, 4);
	assert.equal(s.wait_s, 6, "wall minus the model's time minus the tools'");
	assert.deepEqual(s.tps, { prompt: 500, gen: 21.4 });
	assert.equal(s.mtp_accept, 0.7);
	assert.equal(s.messages, 2);
	assert.equal(s.end, "finished");
	assert.deepEqual(st.contextEvent(), { peak: 198_000, tps_gen: 25, mtp_accept: 0.5, uptime_s: 20 });
	assert.equal(st.statusLine(), "ctx 41K/262K 16% (peak 198K) · 25 t/s · MTP 70% · 0m");
});

test("SessionStats: a server without timings (Ollama, a cloud API) leaves time and speed unknown, not 0", () => {
	const st = new SessionStats(() => 0);
	st.reply({ input: 10, output: 5, cacheRead: 30 });
	const s = st.summary(false);
	assert.equal(s.complete, false);
	assert.equal(s.model_s, null);
	assert.equal(s.tps, null);
	assert.equal(s.wait_s, null);
	assert.equal(s.mtp_accept, null);
	assert.equal((s.tokens as { hit_ratio: number }).hit_ratio, 0.75, "Pi's cacheRead counts when the server reports it");
	assert.equal(st.statusLine(), "0m", "no context known yet, no speed, no MTP");
});

const RUN = join(fileURLToPath(new URL("..", import.meta.url)), "src", "run.ts");

/** A model that answers "Done." with llama-server's usage and timings in the last chunk. */
async function timedServer() {
	const server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
			return;
		}
		req.resume();
		const chunk = (o: object) => `data: ${JSON.stringify({ id: "r1", object: "chat.completion.chunk", ...o })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
		res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		res.write(
			chunk({
				choices: [],
				usage: { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203 },
				timings: { cache_n: 0, prompt_n: 1200, prompt_ms: 600, predicted_n: 3, predicted_ms: 100, draft_n: 4, draft_n_accepted: 3 },
			}),
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

test("run.ts: the events log ends with a session_summary; its message lines carry ts and the session id (#993)", async () => {
	const srv = await timedServer();
	const tmp = tempDir("nerd-stats-tmp-");
	const ws = tempDir("nerd-stats-ws-");
	const sessions = tempDir("nerd-stats-sessions-");
	const log = join(tempDir("nerd-stats-log-"), "events.jsonl");
	try {
		const child = spawn(process.execPath, [RUN, ws, "Say done", "--log", log], {
			env: {
				...process.env,
				TMPDIR: tmp,
				NERD_BASE_URL: srv.url,
				NERD_MODEL: "fake",
				NERD_CTX: "32768",
				NERD_MODE: "solve",
				NERD_PLAN_STEP: "0",
				NERD_RALPH: "0",
				NERD_DONE_GATE: "0",
				NERD_SESSION_DIR: sessions,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		await new Promise<void>((ok) => child.on("exit", () => ok()));
		const lines: Record<string, unknown>[] = [];
		for await (const line of createInterface({ input: createReadStream(log) })) if (line.trim()) lines.push(JSON.parse(line));
		const last = lines.at(-1) as Record<string, any>;
		assert.equal(last.type, "session_summary", out.slice(-2000));
		assert.equal(last.v, 1);
		assert.equal(last.complete, true);
		assert.match(String(last.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		assert.equal(typeof last.session, "string");
		assert.equal(last.messages, 1);
		assert.equal(last.tokens.in, 1200);
		assert.equal(last.tokens.out, 3);
		assert.deepEqual(last.model_s, { prompt: 0.6, gen: 0.1 });
		assert.deepEqual(last.tps, { prompt: 2000, gen: 30 });
		assert.equal(last.mtp_accept, 0.75);
		assert.equal(last.server, srv.url);
		const end = lines.find((l) => l.type === "message_end" && (l.message as { role?: string })?.role === "assistant") as Record<string, any>;
		assert.ok(end, "an assistant message_end in the log");
		assert.equal(end.session, last.session, "the session id on the message line");
		assert.match(String(end.ts), /Z$/);
		assert.ok(end.message.responseId, "the dedup key: the message's responseId");
		assert.ok(!lines.some((l) => l.type === "message_update" && "ts" in l), "per-token updates stay as they were");
	} finally {
		srv.close();
	}
});

test("run.ts: a gate's pause (exit 75) is a complete session, end \"paused\" — the nightly run's usual end (#993 review)", async () => {
	const srv = await timedServer();
	const tmp = tempDir("nerd-stats-tmp-");
	const ws = tempDir("nerd-stats-ws-");
	const sessions = tempDir("nerd-stats-sessions-");
	const dir = tempDir("nerd-stats-log-");
	const log = join(dir, "events.jsonl");
	const gate = join(dir, "gate.sh");
	writeFileSync(gate, 'echo "decision=pause"\necho "reason=the window is over"\n');
	const git = (...a: string[]) => execFileSync("git", ["-C", ws, ...a], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(ws, "PLAN.md"), "# Plan\n\n## Steps\n1. write out.txt\n\n## Done when\n- the file exists — check: `test -f out.txt`\n");
	git("add", "PLAN.md");
	git("commit", "-q", "-m", "Plan");
	try {
		const child = spawn(process.execPath, [RUN, ws, "Carry out PLAN.md", "--log", log], {
			env: {
				...process.env,
				TMPDIR: tmp,
				NERD_BASE_URL: srv.url,
				NERD_MODEL: "fake",
				NERD_CTX: "32768",
				NERD_MODE: "ralph",
				NERD_PLAN_STEP: "0",
				NERD_DONE_GATE: "0",
				NERD_RALPH_GATE: `sh ${gate}`,
				NERD_SESSION_DIR: sessions,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const code = await new Promise<number | null>((ok) => child.on("exit", (c) => ok(c)));
		assert.equal(code, 75, out.slice(-2000));
		const lines: Record<string, unknown>[] = [];
		for await (const line of createInterface({ input: createReadStream(log) })) if (line.trim()) lines.push(JSON.parse(line));
		const last = lines.at(-1) as Record<string, unknown>;
		assert.equal(last.type, "session_summary");
		assert.equal(last.complete, true);
		assert.equal(last.end, "paused");
		assert.equal(last.exit, 75);
	} finally {
		srv.close();
	}
});
