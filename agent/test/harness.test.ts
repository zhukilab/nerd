// The harness of ticket 043 inside a real headless Pi session (headless.ts),
// against a scripted OpenAI-compatible server: which tools each model call is
// offered, what the plan step writes and commits, and the loop guard's note.
// Plus the pure parts: reading the plan reply and the guard's counting.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { harness } from "../src/harness.ts";
import { headlessSession } from "../src/headless.ts";
import { modelDefinition, settingsFor } from "../src/local.ts";
import { LoopGuard, loopGuardN } from "../src/loop-guard.ts";
import { DEFAULT_PLAN_MAX_CALLS, parsePlanReply, planFileText, planMaxCalls } from "../src/plan-step.ts";

for (const [k, v] of Object.entries({
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
})) process.env[k] = v;

// --- pure parts -------------------------------------------------------------

test("plan reply: questions under the heading, none, and the plan from PLAN on", () => {
	const r = parsePlanReply("QUESTIONS\n- Which currency?\n- How many weeks?\nPLAN\n1. page — check: browse\nDONE WHEN\n- it opens");
	assert.deepEqual(r.questions, ["Which currency?", "How many weeks?"]);
	assert.ok(r.plan.startsWith("PLAN\n1. page"));
	assert.ok(r.plan.includes("DONE WHEN"));
	assert.deepEqual(parsePlanReply("**Questions:** none\n\n## Plan\n1. x").questions, []);
	assert.deepEqual(parsePlanReply("QUESTIONS\n- none\nPLAN\n1. x").questions, []);
	assert.deepEqual(parsePlanReply("QUESTIONS: нет\nPLAN:\n1. x").questions, []);
});

test("plan reply without headings: only lines ending in '?' are questions", () => {
	assert.deepEqual(parsePlanReply("Сколько уровней сложности?\nИ нужен ли звук?").questions, [
		"Сколько уровней сложности?",
		"И нужен ли звук?",
	]);
	assert.deepEqual(parsePlanReply("I will write index.html. Then check it.").questions, []);
	// A "?" inside the plan is not a question to the operator.
	assert.deepEqual(parsePlanReply("PLAN\n1. does it load? — check: browse").questions, []);
});

test("plan reply: assumptions are their own section, not questions", () => {
	const r = parsePlanReply("ASSUMPTIONS\n- one user\n- data in the browser?\nQUESTIONS\n- Which currency?\nPLAN\n1. x");
	assert.equal(r.assumptions, "- one user\n- data in the browser?");
	assert.deepEqual(r.questions, ["Which currency?"]);
	const none = parsePlanReply("ASSUMPTIONS:\n- rubles\nQUESTIONS: none\nPLAN\n1. x");
	assert.deepEqual(none.questions, []);
	assert.equal(none.assumptions, "- rubles");
	// without a QUESTIONS heading, a "?" among the assumptions is not a question
	assert.deepEqual(parsePlanReply("ASSUMPTIONS\n- stored where?\nPLAN\n1. x").questions, []);
});

test("plan file: the task quoted, assumptions, questions with the answer, steps and done-when as sections", () => {
	const t = planFileText("Сделай страницу\nдля расходов", { assumptions: "- one user", plan: "PLAN\n1. a\nDONE WHEN\n- b" }, { questions: ["Валюта?"], answer: "рубли" });
	assert.ok(t.includes("## Assumptions\n\n- one user\n"));
	assert.ok(t.includes("> Сделай страницу\n> для расходов"));
	assert.ok(t.includes("- Валюта?\n\nAnswer: рубли"));
	assert.ok(t.includes("## Steps\n\n1. a"));
	assert.ok(t.includes("## Done when\n\n- b"));
});

test("loop guard: N same calls with the same result among the recent ones", () => {
	const g = new LoopGuard(3);
	assert.equal(g.record("bash", { command: "grep -c 19 f" }, "0"), undefined);
	assert.equal(g.record("bash", { command: "grep -c 19 f" }, "0"), undefined);
	// one different call in between does not hide the loop
	assert.equal(g.record("bash", { command: "grep -n 19 f" }, ""), undefined);
	const note = g.record("bash", { command: "grep -c 19 f" }, "0");
	assert.match(note ?? "", /exact call 3 times/);
	// after a note the count starts again: the next note comes 3 repeats later
	assert.equal(g.record("bash", { command: "grep -c 19 f" }, "0"), undefined);
	assert.equal(g.record("bash", { command: "grep -c 19 f" }, "0"), undefined);
	assert.match(g.record("bash", { command: "grep -c 19 f" }, "0") ?? "", /exact call 6 times/);
});

test("loop guard: a changed result or changed arguments is not a repeat; key order does not matter", () => {
	const g = new LoopGuard(3);
	for (const out of ["000", "000", "200"]) assert.equal(g.record("bash", { command: "curl x" }, out), undefined);
	assert.equal(g.record("read", { path: "a", limit: 5 }, "x"), undefined);
	assert.equal(g.record("read", { limit: 5, path: "a" }, "x"), undefined);
	assert.ok(g.record("read", { path: "a", limit: 5 }, "x"));
	const far = new LoopGuard(3);
	far.record("bash", { command: "ls" }, "a");
	for (let i = 0; i < 8; i++) far.record("bash", { command: `echo ${i}` }, `${i}`);
	far.record("bash", { command: "ls" }, "a");
	assert.equal(far.record("bash", { command: "ls" }, "a"), undefined, "repeats far apart are not a loop");
});

test("loop guard: N from the environment, 0 turns it off", () => {
	assert.equal(loopGuardN({}), 3);
	assert.equal(loopGuardN({ NERD_LOOP_GUARD_N: "5" }), 5);
	assert.equal(loopGuardN({ NERD_LOOP_GUARD_N: "x" }), 3);
	const off = new LoopGuard(loopGuardN({ NERD_LOOP_GUARD_N: "0" }));
	for (let i = 0; i < 5; i++) assert.equal(off.record("bash", { command: "ls" }, "a"), undefined);
});

test("plan step budget: NERD_PLAN_MAX_CALLS from the environment, 0 = no budget, junk = default", () => {
	assert.equal(planMaxCalls({}), DEFAULT_PLAN_MAX_CALLS);
	assert.equal(planMaxCalls({ NERD_PLAN_MAX_CALLS: "5" }), 5);
	assert.equal(planMaxCalls({ NERD_PLAN_MAX_CALLS: "0" }), 0);
	assert.equal(planMaxCalls({ NERD_PLAN_MAX_CALLS: "-1" }), DEFAULT_PLAN_MAX_CALLS);
});

// --- in a headless session against a scripted server ------------------------

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };
interface Seen {
	tools: string[];
	lastUser: string;
	lastTool: string;
}

/** An OpenAI-compatible streaming server that answers from `script` and records each request. */
async function scriptedServer(script: (n: number, seen: Seen) => Reply) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const r = JSON.parse(body) as {
				tools?: { function: { name: string } }[];
				messages: { role: string; content: unknown }[];
			};
			const text = (m?: { content: unknown }) =>
				typeof m?.content === "string"
					? m.content
					: Array.isArray(m?.content)
						? (m.content as { text?: string }[]).map((c) => c.text ?? "").join("\n")
						: "";
			const s: Seen = {
				tools: (r.tools ?? []).map((t) => t.function.name).sort(),
				lastUser: text(r.messages.filter((m) => m.role === "user").at(-1)),
				lastTool: text(r.messages.filter((m) => m.role === "tool").at(-1)),
			};
			seen.push(s);
			const reply = script(seen.length, s);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null) =>
				res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			if (reply.call) {
				chunk(
					{
						role: "assistant",
						tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }],
					},
					null,
				);
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

/** A session with the harness; `prompts` are sent one after another, as an operator would type them. */
async function runHeadless(
	baseUrl: string,
	task: string,
	env: NodeJS.ProcessEnv,
	operator = false,
	later: string[] = [],
	inspect?: (session: Awaited<ReturnType<typeof headlessSession>>) => Promise<void>,
) {
	const cwd = mkdtempSync(join(tmpdir(), "nerd-harness-ws-"));
	const agentDir = mkdtempSync(join(tmpdir(), "nerd-harness-agent-"));
	const local = { baseUrl, id: "fake", ctx: 32768, thinking: "off" as const, verifyN: 1 };
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl, api: "openai-completions", apiKey: "none", models: [modelDefinition(local)] } } }),
	);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const model = modelRuntime.getModel("local", "fake")!;
	const session = await headlessSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		thinking: "off",
		settings: { ...settingsFor(local), retry: { enabled: false, maxRetries: 0 } },
		extensions: [harness(operator, env)],
		sessionDir: join(agentDir, "sessions"),
		env,
	});
	try {
		await session.prompt(task);
		for (const p of later) await session.prompt(p);
		if (inspect) await inspect(session);
	} finally {
		session.dispose();
	}
	return cwd;
}

// web_fetch, web_search: rpiv-web-tools is on by default and reads only, so
// the plan turn has them too; vcc_recall: pi-vcc is on by default (packages.ts).
const READ_ONLY = ["find", "grep", "ls", "read", "web_fetch", "web_search"];
const WORK = ["bash", "edit", "read", "vcc_recall", "web_fetch", "web_search", "write"];

test("headless: questions get NERD_PLAN_ANSWER, the final plan is committed, then the work has its tools", async () => {
	const srv = await scriptedServer((n) =>
		[
			{ text: "ASSUMPTIONS\n- plain text\nQUESTIONS\n- Which currency?\nPLAN\n1. draft" },
			{ text: "PLAN\n1. write hello.txt — check: cat it\nDONE WHEN\n- hello.txt says hi" },
			{ call: { name: "write", args: { path: "hello.txt", content: "hi\n" } } },
			{ text: "Done: hello.txt written." },
		][n - 1] ?? { text: "extra" },
	);
	try {
		const cwd = await runHeadless(srv.url, "Make hello.txt", { NERD_PLAN_ANSWER: "euros" });
		assert.equal(srv.seen.length, 4);
		assert.deepEqual(srv.seen[0].tools, READ_ONLY, "plan turn: reading only");
		assert.match(srv.seen[0].lastUser, /\[harness\] A new task/);
		assert.deepEqual(srv.seen[1].tools, READ_ONLY, "final plan: still reading only");
		assert.match(srv.seen[1].lastUser, /The operator's answer: euros/);
		assert.deepEqual(srv.seen[2].tools, WORK, "work: the usual tools");
		assert.match(srv.seen[2].lastUser, /plan is saved in PLAN.md and committed/);
		const plan = readFileSync(join(cwd, "PLAN.md"), "utf8");
		assert.ok(plan.includes("> Make hello.txt") && plan.includes("- Which currency?") && plan.includes("Answer: euros"));
		assert.ok(plan.includes("## Done when"));
		assert.ok(plan.includes("## Assumptions\n\n- plain text"), "assumptions of the first reply are kept");
		assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi\n");
		const log = execFileSync("git", ["log", "--format=%s", "--name-only"], { cwd }).toString();
		assert.match(log, /^Plan\n\nPLAN.md/);
	} finally {
		srv.close();
	}
});

test("with an operator: questions end the turn; the answer leads to the final plan, then work; a remark later is no new task", async () => {
	const srv = await scriptedServer((n) =>
		[
			{ text: "QUESTIONS\n- Which currency?\nPLAN\n1. draft" },
			{ text: "PLAN\n1. page in rubles\nDONE WHEN\n- it shows ₽" },
			{ text: "Done." },
			{ text: "Fixed the colour." },
		][n - 1] ?? { text: "extra" },
	);
	try {
		const cwd = await runHeadless(srv.url, "Make a page", {}, true, ["rubles", "make it blue"]);
		assert.equal(srv.seen.length, 4, "the questions turn ends: no automatic answer");
		assert.deepEqual(srv.seen[1].tools, READ_ONLY, "the answer's turn: final plan, reading only");
		assert.match(srv.seen[1].lastUser, /final plan in the same form/);
		assert.deepEqual(srv.seen[2].tools, WORK);
		assert.deepEqual(srv.seen[3].tools, WORK, "a remark goes straight to work");
		assert.equal(srv.seen[3].lastUser, "make it blue");
		assert.ok(readFileSync(join(cwd, "PLAN.md"), "utf8").includes("Answer: rubles"));
	} finally {
		srv.close();
	}
});

test("headless: no questions — the plan is saved and the work starts in the same run", async () => {
	const srv = await scriptedServer((n) =>
		[{ text: "QUESTIONS\nnone\nPLAN\n1. say hi\nDONE WHEN\n- said" }, { text: "hi" }][n - 1] ?? { text: "extra" },
	);
	try {
		const cwd = await runHeadless(srv.url, "Say hi", {});
		assert.equal(srv.seen.length, 2);
		assert.deepEqual(srv.seen[0].tools, READ_ONLY);
		assert.deepEqual(srv.seen[1].tools, WORK);
		assert.ok(existsSync(join(cwd, "PLAN.md")));
		assert.ok(!readFileSync(join(cwd, "PLAN.md"), "utf8").includes("## Questions"));
	} finally {
		srv.close();
	}
});

test("headless: a plan step that only reads is cut at NERD_PLAN_MAX_CALLS — no tools, a plan, then work (054)", async () => {
	// The model of the A/B in 048: reads (searches) on and on, never replies.
	const srv = await scriptedServer((n, s) =>
		s.tools.length ? (s.tools.includes("write") ? { text: "done" } : { call: { name: "ls", args: { path: `.${"/".repeat(n)}` } } }) : { text: "PLAN\n1. write it — check: cat\nDONE WHEN\n- it is there" },
	);
	try {
		const cwd = await runHeadless(srv.url, "Make a page", { NERD_PLAN_MAX_CALLS: "3" });
		assert.deepEqual(srv.seen.slice(0, 3).map((s) => s.tools), [READ_ONLY, READ_ONLY, READ_ONLY], "three calls in the plan step");
		assert.deepEqual(srv.seen[3].tools, [], "after the 3rd call: no tools");
		assert.match(srv.seen[3].lastTool, /budget is spent and the tools are put away/);
		assert.deepEqual(srv.seen[4].tools, WORK, "the plan is taken, the work has its tools");
		assert.equal(srv.seen.length, 5);
		assert.ok(readFileSync(join(cwd, "PLAN.md"), "utf8").includes("1. write it"));
	} finally {
		srv.close();
	}
});

test("headless: web_search's provider argument is dropped — SearXNG is used, not a provider without a key (054)", async () => {
	process.env.WEB_SEARCH_PROVIDER = "searxng";
	process.env.SEARXNG_URL = "http://127.0.0.1:9"; // nothing listens: SearXNG's own error is expected
	const srv = await scriptedServer((n) =>
		n === 1 ? { call: { name: "web_search", args: { query: "roman numerals", provider: "brave" } } } : { text: "stopped" },
	);
	try {
		await runHeadless(srv.url, "Search", { NERD_PLAN_STEP: "0" });
		assert.equal(srv.seen.length, 2);
		assert.doesNotMatch(srv.seen[1].lastTool, /BRAVE|API_KEY/i, "no keyed provider was tried");
		assert.match(srv.seen[1].lastTool, /searxng|127\.0\.0\.1:9|ECONNREFUSED|fetch failed/i, "it went to SearXNG");
	} finally {
		srv.close();
		delete process.env.WEB_SEARCH_PROVIDER;
		delete process.env.SEARXNG_URL;
	}
});

// Pi's find runs fd with --no-require-git (fd 8.6+); on the old Ubuntu 22.04
// image fd 8.3.1 refused it and every find failed (054). Only where fd is on
// PATH: without it Pi would try to download one.
const hasFd = (() => {
	try {
		execFileSync("fd", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
})();
test("headless: Pi's find works with this machine's fd (054)", { skip: !hasFd && "no fd on PATH" }, async () => {
	const srv = await scriptedServer((n) => (n === 1 ? { call: { name: "find", args: { pattern: "*.txt" } } } : { text: "found" }));
	try {
		await runHeadless(srv.url, "Find", { NERD_PLAN_STEP: "0" }, false, [], async () => {}).then((cwd) => cwd);
		assert.equal(srv.seen.length, 2);
		assert.doesNotMatch(srv.seen[1].lastTool, /error|wasn't expected|not found/i, `find failed: ${srv.seen[1].lastTool}`);
	} finally {
		srv.close();
	}
});

test("headless: NERD_PLAN_STEP=0 goes straight to work; the loop guard notes the third same call", async () => {
	const srv = await scriptedServer((n) => (n <= 4 ? { call: { name: "bash", args: { command: "echo 0" } } } : { text: "stopped" }));
	try {
		const cwd = await runHeadless(srv.url, "Count", { NERD_PLAN_STEP: "0" });
		assert.equal(srv.seen.length, 5);
		assert.deepEqual(srv.seen[0].tools, WORK);
		assert.ok(!existsSync(join(cwd, "PLAN.md")));
		assert.doesNotMatch(srv.seen[2].lastTool, /loop guard/);
		assert.match(srv.seen[3].lastTool, /^0\n[\s\S]*\[loop guard\] You have now made this exact call 3 times/);
		assert.doesNotMatch(srv.seen[4].lastTool, /loop guard/);
	} finally {
		srv.close();
	}
});

test("pi-vcc (default): loaded from node_modules, vcc_recall searches the session file, compaction asks no model", async () => {
	const srv = await scriptedServer((n) =>
		[
			// Large enough that Pi finds something to compact before its kept tail (a quarter of 32K).
			{ call: { name: "write", args: { path: "hello.txt", content: "hi there\n".repeat(6000) } } },
			{ call: { name: "vcc_recall", args: { query: "hello" } } },
			{ text: "done" },
			{ text: "second" },
		][n - 1] ?? { text: "extra" },
	);
	try {
		let compactor: unknown;
		await runHeadless(srv.url, "Make hello.txt", { NERD_PLAN_STEP: "0" }, false, ["and now?"], async (session) => {
			const before = srv.seen.length;
			const result = await session.compact();
			assert.equal(srv.seen.length, before, "no request to the model for the summary");
			compactor = (result.details as { compactor?: string } | undefined)?.compactor;
		});
		assert.deepEqual(srv.seen[0].tools, WORK);
		assert.match(srv.seen[2].lastTool, /hello/, "vcc_recall found the earlier turn");
		assert.doesNotMatch(srv.seen[2].lastTool, /No session file/);
		assert.equal(compactor, "pi-vcc");
	} finally {
		srv.close();
	}
	const off = await scriptedServer(() => ({ text: "done" }));
	try {
		await runHeadless(off.url, "Hi", { NERD_PLAN_STEP: "0", NERD_PI_VCC: "0", NERD_WEB: "0" });
		assert.deepEqual(off.seen[0].tools, ["bash", "edit", "read", "write"], "NERD_PI_VCC=0 NERD_WEB=0: no package tools");
	} finally {
		off.close();
	}
	const noweb = await scriptedServer(() => ({ text: "done" }));
	try {
		await runHeadless(noweb.url, "Hi", { NERD_PLAN_STEP: "0", NERD_WEB: "0" });
		assert.deepEqual(noweb.seen[0].tools, ["bash", "edit", "read", "vcc_recall", "write"], "NERD_WEB=0: no web tools");
	} finally {
		noweb.close();
	}
});

