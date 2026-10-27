// The agora channel (agora-channel.ts; agora-doc docs/PI-CHANNEL.md v1) against a fake
// manager on a unix socket: the wire on its own (hello first, queue until welcome, repeats,
// send_letter's answer and timeout, reconnect, the line limit), then in a real headless
// session against a scripted model server: the events, send_letter as a tool, a letter held
// while the run is idle, and a second session of the same process taking the connection over.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agoraChannel, Channel, closeProcessChannel, MAX_LINE, type Msg, SEND_LETTER_TOOL } from "../src/agora-channel.ts";
import { harness, workTools } from "../src/harness.ts";
import { headlessSession } from "../src/headless.ts";
import { modelDefinition, settingsFor } from "../src/local.ts";
import { tempDir } from "./tmp.ts";

const quiet = { log: () => {}, minDelayMs: 20, maxDelayMs: 100 };

/** A manager: welcomes each hello, records every line, sends what a test asks. */
async function fakeManager(opts: { welcome?: boolean } = {}) {
	const path = join(tempDir("nerd-agora-"), "agora.sock");
	const got: Msg[] = [];
	const conns: Socket[] = [];
	let waiters: (() => void)[] = [];
	const server = createServer((s) => {
		conns.push(s);
		let buf = "";
		s.setEncoding("utf8");
		s.on("error", () => {});
		s.on("data", (c: string) => {
			buf += c;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const m = JSON.parse(buf.slice(0, i)) as Msg;
				buf = buf.slice(i + 1);
				got.push(m);
				if (m.t === "hello" && opts.welcome !== false) s.write(`${JSON.stringify({ t: "welcome", v: 1, agent: "t@agora" })}\n`);
				for (const w of waiters) w();
			}
		});
	});
	await new Promise<void>((ok) => server.listen(path, ok));
	const last = () => conns.at(-1)!;
	return {
		path,
		got,
		conns,
		send: (m: Msg | string) => last().write(typeof m === "string" ? m : `${JSON.stringify(m)}\n`),
		/** The first message matching `pred`, waited for up to `ms`. */
		waitFor: (pred: (m: Msg) => boolean, ms = 3000) =>
			new Promise<Msg>((ok, fail) => {
				const check = () => {
					const m = got.find(pred);
					if (m) {
						clearTimeout(t);
						waiters = waiters.filter((w) => w !== check);
						ok(m);
					}
				};
				const t = setTimeout(() => fail(new Error(`not seen in ${ms} ms; got ${JSON.stringify(got.map((g) => g.hook ?? g.t))}`)), ms);
				waiters.push(check);
				check();
			}),
		close: () => {
			for (const c of conns) c.destroy();
			server.close();
		},
	};
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const owner = (letters: Msg[] = []) => ({ hello: () => ({ t: "hello", v: 1, mode: "run", idle: true }), letter: (m: Msg) => letters.push(m) });

// --- the wire ----------------------------------------------------------------

test("wire: hello first; what is sent before welcome waits for it; a letter goes to the owner; a repeat is acked only", async () => {
	const mgr = await fakeManager({ welcome: false });
	const ch = new Channel(mgr.path, quiet);
	const letters: Msg[] = [];
	try {
		ch.attach(owner(letters));
		ch.send({ t: "event", hook: "SessionStart" });
		await mgr.waitFor((m) => m.t === "hello");
		await sleep(50);
		assert.deepEqual(mgr.got.map((m) => m.t), ["hello"]);
		mgr.send({ t: "welcome", v: 1, agent: "t@agora" });
		await mgr.waitFor((m) => m.hook === "SessionStart");
		mgr.send({ t: "letter", id: "L1", text: "hi" });
		await sleep(50);
		assert.deepEqual(letters.map((l) => l.id), ["L1"]);
		ch.injected.add("L1");
		mgr.send({ t: "letter", id: "L1", text: "hi" });
		await mgr.waitFor((m) => m.t === "ack" && m.id === "L1");
		assert.equal(letters.length, 1);
		mgr.send("not json\n");
		await mgr.waitFor((m) => m.t === "error" && m.error === "line is not JSON");
	} finally {
		ch.close();
		mgr.close();
	}
});

test("wire: send_letter gets the answer with its id; no answer in time is an error, not a hang", async () => {
	const mgr = await fakeManager();
	const ch = new Channel(mgr.path, { ...quiet, answerMs: 200 });
	try {
		ch.attach(owner());
		await mgr.waitFor((m) => m.t === "hello");
		await sleep(30);
		const r = ch.request({ t: "send_letter", to: "operator", subject: "s", body: "b" });
		const sent = await mgr.waitFor((m) => m.t === "send_letter");
		mgr.send({ t: "letter_result", id: sent.id, ok: true, letter_id: "X1" });
		assert.deepEqual(await r, { t: "letter_result", id: sent.id, ok: true, letter_id: "X1" });
		const late = await ch.request({ t: "send_letter", to: "operator", subject: "s", body: "b" });
		assert.equal(late.ok, false);
		assert.match(String(late.error), /manager did not answer/);
	} finally {
		ch.close();
		mgr.close();
	}
});

test("wire: a broken connection comes back with a new hello; a line over 1 MiB closes it", async () => {
	const mgr = await fakeManager();
	const ch = new Channel(mgr.path, quiet);
	try {
		ch.attach(owner());
		await mgr.waitFor((m) => m.t === "hello");
		mgr.conns[0].destroy();
		await sleep(300);
		assert.equal(mgr.got.filter((m) => m.t === "hello").length, 2);
		assert.ok(ch.connected);
		mgr.send("x".repeat(MAX_LINE + 10));
		await mgr.waitFor((m) => m.t === "error" && /1 MiB/.test(String(m.error)));
		await sleep(300);
		assert.equal(mgr.got.filter((m) => m.t === "hello").length, 3);
	} finally {
		ch.close();
		mgr.close();
	}
});

// --- in a headless session -----------------------------------------------------

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };

/** An OpenAI-compatible streaming server answering from `script`; records each request's tools and messages. */
async function scriptedServer(script: (n: number) => Reply) {
	const seen: { tools: string[]; all: string; lastTool: string }[] = [];
	const server = httpServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const r = JSON.parse(body) as { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };
			const text = (m?: { content: unknown }) =>
				typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? (m.content as { text?: string }[]).map((c) => c.text ?? "").join("\n") : "";
			seen.push({
				tools: (r.tools ?? []).map((t) => t.function.name).sort(),
				all: r.messages.map(text).join("\n"),
				lastTool: text(r.messages.filter((m) => m.role === "tool").at(-1)),
			});
			const reply = script(seen.length);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null) =>
				res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			if (reply.call) {
				chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }, null);
				chunk({}, "tool_calls");
			} else {
				chunk({ role: "assistant", content: reply.text ?? "" }, null);
				chunk({}, "stop");
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

/** A headless session with the harness (no plan step) and the channel in mode "run", as run.ts makes it. */
async function session(baseUrl: string, sock: string) {
	const env = { NERD_PLAN_STEP: "0", NERD_AGORA_CHANNEL: sock };
	const cwd = tempDir("nerd-agora-ws-");
	const agentDir = tempDir("nerd-agora-agent-");
	const local = { baseUrl, id: "fake", ctx: 32768, thinking: "off" as const, verifyN: 1 };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl, api: "openai-completions", apiKey: "none", models: [modelDefinition(local)] } } }));
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	return headlessSession({
		cwd,
		agentDir,
		model: modelRuntime.getModel("local", "fake")!,
		modelRuntime,
		thinking: "off",
		settings: { ...settingsFor(local), retry: { enabled: false, maxRetries: 0 } },
		extensions: [harness(false, env), agoraChannel("run", sock, quiet)],
		sessionDir: join(agentDir, "sessions"),
		env,
	});
}

test("send_letter is a work tool only with NERD_AGORA_CHANNEL", () => {
	assert.ok(workTools({ NERD_AGORA_CHANNEL: "/run/agora/agora.sock" }).includes(SEND_LETTER_TOOL));
	assert.ok(!workTools({}).includes(SEND_LETTER_TOOL));
});

test("run: hook events in order, send_letter through the manager, Stop with the last text, the context share", async () => {
	const mgr = await fakeManager();
	const srv = await scriptedServer((n) => (n === 1 ? { call: { name: SEND_LETTER_TOOL, args: { to: "operator", subject: "s", body: "b" } } } : { text: "All done." }));
	const s = await session(srv.url, mgr.path);
	try {
		const answer = mgr.waitFor((m) => m.t === "send_letter").then((m) => mgr.send({ t: "letter_result", id: m.id, ok: true, letter_id: "X9" }));
		await s.prompt("Write to the operator");
		await answer;
		const stop = await mgr.waitFor((m) => m.hook === "Stop");
		assert.equal(stop.last_assistant_message, "All done.");
		assert.equal(stop.outcome, "completed");
		const hello = mgr.got[0];
		assert.equal(hello.t, "hello");
		assert.equal(hello.mode, "run");
		assert.equal(hello.pid, process.pid);
		const hooks = mgr.got.filter((m) => m.t === "event").map((m) => m.hook);
		assert.deepEqual(hooks, ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
		assert.deepEqual(
			mgr.got.filter((m) => m.hook === "PostToolUse").map((m) => [m.tool_name, m.is_error]),
			[[SEND_LETTER_TOOL, false]],
		);
		assert.ok(srv.seen[0].tools.includes(SEND_LETTER_TOOL));
		assert.equal(srv.seen[1].lastTool, "sent, id X9");
		const ctx = mgr.got.find((m) => m.t === "context");
		assert.equal(ctx?.window, 32768);
	} finally {
		s.dispose();
		closeProcessChannel();
		srv.close();
		mgr.close();
	}
});

test("run: a letter while the run is idle waits for the next turn, then goes in as a follow-up and is acked", async () => {
	const mgr = await fakeManager();
	const srv = await scriptedServer(() => ({ text: "ok" }));
	const s = await session(srv.url, mgr.path);
	try {
		await s.prompt("first");
		await mgr.waitFor((m) => m.hook === "Stop");
		mgr.send({ t: "letter", id: "L1", from: "operator@agora", subject: "x", body: "y", urgent: false, text: "LETTER from the operator: please also add a README" });
		await sleep(300);
		assert.ok(!mgr.got.some((m) => m.t === "ack"), "no ack while idle in run mode");
		assert.equal(srv.seen.length, 1, "the letter started no turn of its own");
		await s.prompt("second");
		await mgr.waitFor((m) => m.t === "ack" && m.id === "L1");
		await mgr.waitFor((m) => m.hook === "Stop" && mgr.got.filter((g) => g.hook === "Stop").length >= 2);
		await sleep(100);
		assert.ok(srv.seen.some((r) => r.all.includes("LETTER from the operator: please also add a README")));
	} finally {
		s.dispose();
		closeProcessChannel();
		srv.close();
		mgr.close();
	}
});

test("run: a second session in the process (a fresh Ralph round) takes the one connection and the letters over", async () => {
	const mgr = await fakeManager();
	const srv = await scriptedServer(() => ({ text: "ok" }));
	const a = await session(srv.url, mgr.path);
	let b: Awaited<ReturnType<typeof session>> | undefined;
	try {
		await a.prompt("round 1");
		await mgr.waitFor((m) => m.hook === "Stop");
		// As run.ts does: the new session first, then the old one disposed.
		b = await session(srv.url, mgr.path);
		a.dispose();
		const before = mgr.got.length;
		await b.prompt("round 2");
		await mgr.waitFor((m) => m.hook === "Stop" && mgr.got.indexOf(m) >= before);
		assert.equal(mgr.conns.length, 1, "one connection for the process");
		assert.equal(mgr.got.filter((m) => m.t === "hello").length, 1);
		assert.equal(mgr.got.filter((m) => m.hook === "SessionStart").length, 2);
		assert.ok(!mgr.got.some((m) => m.hook === "SessionEnd"));
		// The letter goes to b: it is injected at b's next turn.
		mgr.send({ t: "letter", id: "L2", text: "LETTER two", urgent: false });
		await b.prompt("round 3");
		await mgr.waitFor((m) => m.t === "ack" && m.id === "L2");
	} finally {
		(b ?? a).dispose();
		closeProcessChannel();
		srv.close();
		mgr.close();
	}
});
