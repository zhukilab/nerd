// run.ts's arguments: the workspace, then the task as text or, from a session manager (agora,
// process ticket 095), as a file: `--task-file <path>`. A file has no argv word limit
// (about 128 KiB on Linux) and reads better in logs. The manager removes the file once the run
// has answered, so it is read here, at the start.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const RUN_USAGE =
	'usage: node src/run.ts <workspace-dir> ["<task>" | --task-file <path>] [--log events.jsonl] (no task: NERD_PROBLEM_FILE, relative to the workspace)';
/** A task goes into the prompt whole; more than this does not fit any context we run. */
export const MAX_TASK_BYTES = 4 << 20;

export type RunArgs = { workspace: string; task: string; log?: string } | { error: string };

function taskFile(path: string): { task: string } | { error: string } {
	let task: string;
	try {
		const size = statSync(path).size;
		if (size > MAX_TASK_BYTES) return { error: `the task file ${path} is ${size} bytes, over ${MAX_TASK_BYTES}` };
		task = readFileSync(path, "utf8"); // whole-read: size checked above, the task goes into the prompt whole
	} catch (e) {
		return { error: `the task file ${path}: ${(e as Error).message}` };
	}
	if (!task.trim()) return { error: `the task file ${path} is empty` };
	return { task };
}

/**
 * With no task in argv, NERD_PROBLEM_FILE (process ticket 104): the problem described in a file,
 * a path relative to the workspace. The operator edits it and runs the plan again (NERD_MODE=plan):
 * the plan is revised to it.
 */
export function runArgs(argv: string[], env: Record<string, string | undefined> = process.env, taskOptional = false): RunArgs {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const [workspace, second] = argv;
	if (!workspace || workspace.startsWith("--")) return { error: RUN_USAGE };
	const log = flag("--log");
	if (second === "--task-file") {
		const path = flag("--task-file");
		if (!path) return { error: RUN_USAGE };
		const t = taskFile(path);
		return "error" in t ? t : { workspace, task: t.task, log };
	}
	if (!second || second.startsWith("--")) {
		const problem = env.NERD_PROBLEM_FILE?.trim();
		// taskOptional: run.ts decides (NERD_MODE=ralph with a PLAN.md there needs none).
		if (!problem) return taskOptional ? { workspace, task: "", log } : { error: RUN_USAGE };
		const t = taskFile(resolve(workspace, problem));
		return "error" in t ? t : { workspace, task: t.task, log };
	}
	return { workspace, task: second, log };
}
