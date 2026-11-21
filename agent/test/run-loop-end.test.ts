// #1013: the loop guard's third cut ends the turn with no steer; the reply then stops with Pi's
// "aborted" error. Under Ralph that is the guard's end of the turn, not the model server failing:
// the run must check the work and go on to the next round, not stop with "the model request failed".
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";

const RUN = join(fileURLToPath(new URL("..", import.meta.url)), "src", "run.ts");

/** A model that answers every request with the same bash call: a loop the guard must catch. */
async function loopingServer() {
	let n = 0;
	const server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
			return;
		}
		req.resume();
		n++;
		const chunk = (delta: unknown, finish: string | null) =>
			`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call${n}`, type: "function", function: { name: "bash", arguments: "" } }] }, null));
		res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo 7" }) } }] }, null));
		res.write(chunk({}, "tool_calls"));
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests: () => n, close: () => server.close() };
}

test("run.ts under Ralph: a turn the loop guard ended goes to the check and the next round, not a model failure (#1013)", async () => {
	const srv = await loopingServer();
	const tmp = tempDir("nerd-loopend-tmp-");
	const ws = tempDir("nerd-loopend-ws-");
	const sessions = tempDir("nerd-loopend-sessions-");
	try {
		const git = (...a: string[]) => execFileSync("git", ["-C", ws, ...a], { stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		writeFileSync(join(ws, "PLAN.md"), "# Plan\n\n## Steps\n1. write out.txt\n\n## Done when\n- the file exists — check: `test -f out.txt`\n");
		git("add", "PLAN.md");
		git("commit", "-q", "-m", "Plan");
		const child = spawn(process.execPath, [RUN, ws, "Carry out PLAN.md"], {
			env: {
				...process.env,
				TMPDIR: tmp,
				NERD_BASE_URL: srv.url,
				NERD_MODEL: "fake",
				NERD_CTX: "32768",
				NERD_MODE: "ralph",
				NERD_PLAN_STEP: "0",
				NERD_DONE_GATE: "0",
				NERD_RALPH_ROUNDS: "2",
				NERD_LOOP_GUARD_N: "2",
				NERD_LOOP_GUARD_HARD: "1",
				NERD_SESSION_DIR: sessions,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const code = await new Promise<number | null>((ok) => {
			const t = setTimeout(() => child.kill("SIGKILL"), 120_000);
			child.on("exit", (c) => {
				clearTimeout(t);
				ok(c);
			});
		});
		assert.match(out, /\[harness: the loop guard ended the turn/, out.slice(-3000));
		assert.doesNotMatch(out, /the model request failed/, out.slice(-3000));
		assert.match(out, /\[ralph round \d+\/2/, "Ralph checked the work after the guard's end of the turn");
		assert.ok(code !== null, "the run ended by itself");
		assert.ok(srv.requests() > 6, "the second round asked the model again");
	} finally {
		srv.close();
	}
});
