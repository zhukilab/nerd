// run.ts under a manager (agora, process ticket 042): SIGTERM and SIGINT abort the turn and end the
// run as its finally does — exit 143/130, the temp agent dir removed — instead of Node's default death.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";

const RUN = join(fileURLToPath(new URL("..", import.meta.url)), "src", "run.ts");

/** A server whose reply never ends: a few characters every 50 ms. `asked` resolves on the first request. */
async function endlessServer() {
	let asked!: () => void;
	const first = new Promise<void>((ok) => (asked = ok));
	const server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
			return;
		}
		req.resume();
		asked();
		res.writeHead(200, { "content-type": "text/event-stream" });
		const t = setInterval(() => {
			res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "la " }, finish_reason: null }] })}\n\n`);
		}, 50);
		res.on("close", () => clearInterval(t));
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	return { first, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
	test(`run.ts: ${sig} mid-turn ends the run with ${code} and removes its temp agent dir`, async () => {
		const srv = await endlessServer();
		const tmp = tempDir("nerd-signals-tmp-");
		const ws = tempDir("nerd-signals-ws-");
		const sessions = tempDir("nerd-signals-sessions-");
		try {
			const child = spawn(process.execPath, [RUN, ws, "Say hi"], {
				env: {
					...process.env,
					TMPDIR: tmp,
					NERD_BASE_URL: srv.url,
					NERD_MODEL: "fake",
					NERD_CTX: "32768",
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
			const exited = new Promise<number | null>((ok) => child.on("exit", (c) => ok(c)));
			await srv.first;
			await new Promise((ok) => setTimeout(ok, 300));
			child.kill(sig);
			const exit = await Promise.race([exited, new Promise<"hung">((ok) => setTimeout(() => ok("hung"), 15_000))]);
			if (exit === "hung") child.kill("SIGKILL");
			assert.equal(exit, code, out);
			assert.match(out, new RegExp(`\\[${sig}: the run is stopped\\]`));
			assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("nerd-agent-")), [], "the temp agent dir is removed");
		} finally {
			srv.close();
		}
	});
}
