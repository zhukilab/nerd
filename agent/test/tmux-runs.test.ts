// The agent's commands in tmux session nerd-runs (tmux-runs.ts, process ticket 098), on a tmux
// server of their own (-L), killed at the end: output and exit code as Pi's own bash, a
// timeout and an abort kill the command, Ctrl-C in the window gives 130, background commands
// start, show output, stop and end with the process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import { Runs, RUNS_SESSION, runsTool, tmuxOperations } from "../src/tmux-runs.ts";
import { tempDir } from "./tmp.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const socket = `nerd-test-${process.pid}`;
const runs = hasTmux ? new Runs({ socket, keep: 2 }) : undefined;
after(() => {
	spawnSync("tmux", ["-L", socket, "kill-server"]);
	runs?.close();
});
const skip = hasTmux ? false : "no tmux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exec(command: string, o: { timeout?: number; signal?: AbortSignal } = {}) {
	const chunks: Buffer[] = [];
	const ops = tmuxOperations(runs!);
	const r = await ops.exec(command, tempDir("nerd-runs-cwd-"), { onData: (b) => chunks.push(b), env: { ...process.env, MARK: "m1" }, ...o });
	return { ...r, out: Buffer.concat(chunks).toString() };
}

test("a command in a window: its output, stderr included, the environment given, the exit code", { skip }, async () => {
	const r = await exec('echo "out $MARK"; echo err >&2; pwd | grep -q nerd-runs-cwd && exit 3');
	assert.equal(r.exitCode, 3);
	assert.match(r.out, /out m1/);
	assert.match(r.out, /err/);
	const names = runs!.tmux("list-windows", "-t", `=${RUNS_SESSION}`, "-F", "#{window_name}").stdout;
	assert.match(names, /^c\d+ echo/m);
});

test("a timeout kills the command and reports timeout:N, as Pi's own", { skip }, async () => {
	const t0 = Date.now();
	await assert.rejects(exec("echo started; sleep 30", { timeout: 1 }), /^Error: timeout:1$/);
	assert.ok(Date.now() - t0 < 5000);
});

test("an abort kills the command and reports aborted", { skip }, async () => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 500);
	await assert.rejects(exec("sleep 30", { signal: ac.signal }), /^Error: aborted$/);
});

test("Ctrl-C in the window stops the command with 130, the output so far kept", { skip }, async () => {
	const p = exec("echo before; sleep 30; echo after");
	await sleep(1000);
	const wins = runs!.tmux("list-windows", "-t", `=${RUNS_SESSION}`, "-F", "#{window_id} #{window_name}").stdout.trim().split("\n");
	const wid = wins.filter((l) => / c\d+ echo before/.test(l)).at(-1)!.split(" ")[0];
	runs!.tmux("send-keys", "-t", wid, "C-c");
	const r = await p;
	assert.equal(r.exitCode, 130);
	assert.match(r.out, /before/);
	assert.doesNotMatch(r.out, /after/);
});

test("finished windows beyond keep are closed", { skip }, async () => {
	for (let i = 0; i < 4; i++) await exec(`echo n${i}`);
	const done = runs!.tmux("list-windows", "-t", `=${RUNS_SESSION}`, "-F", "#{@nerd_done}").stdout.split("\n").filter((l) => l === "1");
	assert.ok(done.length <= 2, `finished windows: ${done.length}`);
});

test("runs: start, output, list, stop; close kills what still runs", { skip }, async () => {
	const tool = runsTool(tempDir("nerd-runs-bg-"), runs!, () => process.env);
	const call = async (p: Record<string, unknown>) => {
		const r = await tool.execute("t", p as never, undefined, undefined, undefined as never);
		return (r.content[0] as { text: string }).text;
	};
	const started = await call({ action: "start", command: "for i in 1 2 3; do echo tick$i; sleep 0.2; done; sleep 30" });
	const id = started.match(/started (b\d+)/)![1];
	await sleep(1000);
	assert.match(await call({ action: "output", id, lines: 2 }), /tick2\ntick3/);
	assert.match(await call({ action: "list" }), new RegExp(`${id}  running`));
	assert.match(await call({ action: "stop", id }), new RegExp(`${id} exited 137`));
	const again = await call({ action: "start", command: "sleep 30" });
	const run = runs!.background.get(again.match(/started (b\d+)/)![1])!;
	await sleep(300);
	const pgid = Number(spawnSync("cat", [`${run.dir}/pgid`], { encoding: "utf8" }).stdout);
	runs!.close();
	await sleep(300);
	assert.throws(() => process.kill(pgid, 0), "the background command is gone after close");
	assert.ok(!existsSync(runs!.root));
});
