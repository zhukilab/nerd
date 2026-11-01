// run.ts's arguments (run-args.ts): the task as text or from a file (--task-file, from agora's
// manager), and the usage errors that end the run with exit code 2.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_TASK_BYTES, runArgs } from "../src/run-args.ts";
import { tempDir } from "./tmp.ts";

test("run args: the task as text, with or without --log", () => {
	assert.deepEqual(runArgs(["/w", "do it"]), { workspace: "/w", task: "do it", log: undefined });
	assert.deepEqual(runArgs(["/w", "do it", "--log", "/l.jsonl"]), { workspace: "/w", task: "do it", log: "/l.jsonl" });
});

test("run args: --task-file reads the task, newlines and all", () => {
	const f = join(tempDir("nerd-run-args-"), "task-1.txt");
	writeFileSync(f, "line one\nline two\n");
	assert.deepEqual(runArgs(["/w", "--task-file", f, "--log", "/l.jsonl"]), { workspace: "/w", task: "line one\nline two\n", log: "/l.jsonl" });
});

test("run args: a missing, empty or oversized task file, or no task, is an error", () => {
	const d = tempDir("nerd-run-args-");
	const empty = join(d, "empty.txt");
	writeFileSync(empty, " \n");
	const big = join(d, "big.txt");
	writeFileSync(big, Buffer.alloc(MAX_TASK_BYTES + 1, 97));
	for (const argv of [["/w", "--task-file", join(d, "none.txt")], ["/w", "--task-file", empty], ["/w", "--task-file", big], ["/w", "--task-file"], ["/w"], ["/w", "--log", "x"], []]) {
		assert.ok("error" in runArgs(argv, {}), JSON.stringify(argv.map((a) => a.slice(-12))));
	}
});

test("run args: no task given — NERD_PROBLEM_FILE, relative to the workspace (process ticket 104)", () => {
	const w = tempDir("nerd-run-args-");
	writeFileSync(join(w, "PROBLEM.md"), "Make a clock.\nIn red.\n");
	const env = { NERD_PROBLEM_FILE: "PROBLEM.md" };
	assert.deepEqual(runArgs([w], env), { workspace: w, task: "Make a clock.\nIn red.\n", log: undefined });
	assert.deepEqual(runArgs([w, "--log", "/l"], env), { workspace: w, task: "Make a clock.\nIn red.\n", log: "/l" });
	assert.equal((runArgs([w, "the argument wins"], env) as { task: string }).task, "the argument wins");
	assert.match((runArgs([w], { NERD_PROBLEM_FILE: "NONE.md" }) as { error: string }).error, /NONE\.md/);
});
