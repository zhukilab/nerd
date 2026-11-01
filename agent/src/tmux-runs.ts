// The agent's commands in tmux session "nerd-runs" (process ticket 098): each bash call runs in
// a window of its own, so a person (or another agent) can `tmux attach -t nerd-runs` and watch
// it live, and Ctrl-C there stops that command (the model sees exit code 130). Before, a
// command was a child of Pi and nothing of it was visible while it ran.
//
//   - bash: Pi's own tool with these operations (bash-tool.ts): output, exit code, timeout
//     and abort as before; the output goes to a file and to the window at once;
//   - runs: commands in the background (a dev server, a long build): start, list, output,
//     stop. Before, such a command held the turn until its timeout, or went `&` and was lost.
//
// Windows are named c<N> (a bash call) and b<N> (a background command). A finished window
// keeps its screen until there are more than NERD_RUNS_KEEP of them; background commands are
// killed when the process ends (the TUI's exit, the run's end or its SIGTERM).
// NERD_RUNS=0, or no tmux, runs commands as Pi does, without windows.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type BashOperations, defineTool } from "@earendil-works/pi-coding-agent";

export const RUNS_SESSION = "nerd-runs";
export const RUNS_TOOL = "runs";
export const DEFAULT_RUNS_KEEP = 10;

/** Windows for the commands: NERD_RUNS (default on) and tmux installed. */
export function tmuxRunsOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_RUNS !== "0" && tmuxInstalled();
}

/** The background tool: NERD_RUNS_BACKGROUND (default on), with windows. */
export function runsToolOn(env: Record<string, string | undefined> = process.env): boolean {
	return env.NERD_RUNS_BACKGROUND !== "0" && tmuxRunsOn(env);
}

export function runsKeep(env: Record<string, string | undefined> = process.env): number {
	const v = Number(env.NERD_RUNS_KEEP);
	return Number.isInteger(v) && v >= 0 ? v : DEFAULT_RUNS_KEEP;
}

let installed: boolean | undefined;
function tmuxInstalled(): boolean {
	installed ??= spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
	return installed;
}

// The window's script: the environment from env0, the command in a job of its own (set -m), so
// a timeout or a stop kills its group (pgid) and not this script. The terminal's Ctrl-C may
// reach this script too: a handler (not an ignore, which the command would inherit) keeps it
// alive to write rc; tee ignores it and keeps the output to the end. The window is marked done
// before rc is written: the tidy that follows rc counts it (the other way round, under load, one
// window too many stayed).
const RUNNER = `#!/bin/bash
d=$1
trap 'true' INT
while IFS= read -r -d '' kv; do export "$kv"; done < "$d/env0"
cd "$(cat "$d/cwd")" || { echo 1 > "$d/rc"; exit 1; }
printf '\\033[1m$ %s\\033[0m\\n' "$(cat "$d/cmd")"
set -m
bash -c 'echo $$ > "$1/pgid"; exec bash -c "$(cat "$1/cmd")"' _ "$d" < /dev/null 2>&1 | (trap '' INT; exec tee -a "$d/out")
rc=\${PIPESTATUS[0]}
set +m
tmux set-option -w -t "$TMUX_PANE" @nerd_done 1 2>/dev/null
echo "$rc" > "$d/rc.tmp" && mv "$d/rc.tmp" "$d/rc"
printf '\\n[exit %s]\\n' "$rc"
exec sleep infinity
`;

/** One command in a window. */
export interface Run {
	id: string;
	command: string;
	dir: string;
	startedAt: number;
	/** The exit code once it has ended. */
	exitCode(): number | undefined;
	/** Output bytes from `offset` on (at most `max`). */
	read(offset: number, max?: number): Buffer;
	/** Kills the command's process group; true once it was signalled. */
	kill(): boolean;
	/** The window is gone (closed by hand) before the command wrote its exit code. */
	gone(): boolean;
}

export interface RunsOptions {
	/** tmux -L <socket> (tests); the default server otherwise, the one Pi's TUI is in. */
	socket?: string;
	keep?: number;
}

/** The process's commands: one temp dir, one counter, one session. */
export class Runs {
	readonly root: string;
	private n = 0;
	readonly background = new Map<string, Run>();
	private readonly socket?: string;
	private readonly keep: number;

	constructor(o: RunsOptions = {}) {
		this.socket = o.socket;
		this.keep = o.keep ?? DEFAULT_RUNS_KEEP;
		this.root = mkdtempSync(join(tmpdir(), "nerd-runs-"));
		writeFileSync(join(this.root, "runner.sh"), RUNNER, { mode: 0o755 });
	}

	tmux(...args: string[]) {
		return spawnSync("tmux", [...(this.socket ? ["-L", this.socket] : []), ...args], { encoding: "utf8" });
	}

	private session() {
		if (this.tmux("has-session", "-t", `=${RUNS_SESSION}`).status === 0) return;
		const about = "printf 'nerd-runs: the agent commands, one window each (c: bash calls, b: background).\\n'; exec sleep infinity";
		const r = this.tmux("new-session", "-d", "-s", RUNS_SESSION, "-n", "about", "-x", "200", "-y", "50", about);
		if (r.status !== 0 && this.tmux("has-session", "-t", `=${RUNS_SESSION}`).status !== 0) {
			throw new Error(`tmux session ${RUNS_SESSION} did not start: ${r.stderr.trim()}`);
		}
	}

	start(command: string, cwd: string, env: NodeJS.ProcessEnv, kind: "c" | "b"): Run {
		const id = `${kind}${++this.n}`;
		const dir = join(this.root, id);
		mkdirSync(dir);
		writeFileSync(join(dir, "cmd"), command);
		writeFileSync(join(dir, "cwd"), cwd);
		writeFileSync(join(dir, "out"), "");
		const vars = Object.entries(env).filter(([k, v]) => v !== undefined && !k.includes("="));
		writeFileSync(join(dir, "env0"), vars.map(([k, v]) => `${k}=${v}\0`).join(""));
		this.session();
		const name = `${id} ${command.replace(/\s+/g, " ").slice(0, 24)}`;
		const r = this.tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${RUNS_SESSION}:`, "-n", name, "bash", join(this.root, "runner.sh"), dir);
		if (r.status !== 0) throw new Error(`tmux new-window: ${r.stderr.trim()}`);
		const wid = r.stdout.trim();
		const small = (f: string) => {
			try {
				return readFileSync(join(dir, f), "utf8").trim(); // whole-read: a number the runner wrote
			} catch {
				return undefined;
			}
		};
		return {
			id,
			command,
			dir,
			startedAt: Date.now(),
			exitCode: () => {
				const rc = small("rc");
				return rc === undefined ? undefined : Number(rc);
			},
			read: (offset, max = 1 << 20) => readFrom(join(dir, "out"), offset, max),
			kill: () => {
				const pgid = Number(small("pgid"));
				if (!(pgid > 1)) return false;
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					// already gone
				}
				return true;
			},
			gone: () => this.tmux("list-panes", "-t", wid).status !== 0 && small("rc") === undefined,
		};
	}

	/** Closes finished windows beyond the newest `keep` (and drops their files). */
	tidy() {
		const r = this.tmux("list-windows", "-t", `=${RUNS_SESSION}`, "-F", "#{window_id}\t#{@nerd_done}\t#{window_name}");
		if (r.status !== 0) return;
		const done = r.stdout
			.split("\n")
			.map((l) => l.split("\t"))
			.filter(([id, d]) => id && d === "1");
		for (const [wid, , name] of done.slice(0, Math.max(0, done.length - this.keep))) {
			this.tmux("kill-window", "-t", wid);
			const id = name.split(" ")[0];
			if (/^c\d+$/.test(id)) rmSync(join(this.root, id), { recursive: true, force: true });
		}
	}

	/** At the end of the process: background commands killed, the files removed. */
	close() {
		for (const run of this.background.values()) if (run.exitCode() === undefined) run.kill();
		rmSync(this.root, { recursive: true, force: true });
	}
}

function readFrom(path: string, offset: number, max: number): Buffer {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return Buffer.alloc(0);
	}
	try {
		const size = statSync(path).size;
		const n = Math.max(0, Math.min(size - offset, max));
		const buf = Buffer.alloc(n);
		const got = n ? readSync(fd, buf, 0, n, offset) : 0;
		return buf.subarray(0, got);
	} finally {
		closeSync(fd);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let processRuns: Runs | undefined;
/** The process's one Runs, closed when the process exits. */
export function runsOfProcess(o: RunsOptions = {}): Runs {
	if (!processRuns) {
		const runs = new Runs({ keep: runsKeep(), socket: process.env.NERD_RUNS_SOCKET || undefined, ...o });
		processRuns = runs;
		process.once("exit", () => runs.close());
	}
	return processRuns;
}

/** Pi's bash operations through windows: the same exit code, "aborted" and "timeout:N" as Pi's own. */
export function tmuxOperations(runs: Runs): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const run = runs.start(command, cwd, env ?? process.env, "c");
			let why: "aborted" | "timeout" | undefined;
			const stop = (w: "aborted" | "timeout") => {
				why ??= w;
			};
			const onAbort = () => stop("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = timeout && timeout > 0 ? setTimeout(() => stop("timeout"), timeout * 1000) : undefined;
			let offset = 0;
			let pause = 20;
			let checked = Date.now();
			try {
				for (;;) {
					// A window closed by hand ends the command without an exit code (Pi reports that).
					if (Date.now() - checked > 1000) {
						checked = Date.now();
						if (run.gone()) {
							run.kill();
							onData(run.read(offset));
							return { exitCode: null };
						}
					}
					const rc = run.exitCode();
					const chunk = run.read(offset);
					if (chunk.length) {
						offset += chunk.length;
						onData(chunk);
					}
					if (rc !== undefined) {
						if (why === "aborted") throw new Error("aborted");
						if (why === "timeout") throw new Error(`timeout:${timeout}`);
						return { exitCode: rc };
					}
					if (why) run.kill();
					await sleep(pause);
					pause = Math.min(pause * 2, 200);
				}
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				runs.tidy();
			}
		},
	};
}

/** The last `lines` lines of a run's output (a bounded window from its end). */
export function tail(run: Run, lines: number): string {
	const size = statSize(join(run.dir, "out"));
	const window = 64 << 10;
	const text = run.read(Math.max(0, size - window), window).toString("utf8");
	const all = text.split("\n");
	if (all.at(-1) === "") all.pop();
	return all.slice(-lines).join("\n");
}

function statSize(path: string): number {
	return existsSync(path) ? statSync(path).size : 0;
}

/** The background tool. */
export function runsTool(cwd: string, runs: Runs, envOf: () => NodeJS.ProcessEnv) {
	return defineTool({
		name: RUNS_TOOL,
		label: "runs",
		description:
			`Commands in the background, for what must keep running while you work: a dev server, a watcher, a long build. ` +
			`start runs a command in a window of tmux session ${RUNS_SESSION} and returns its id at once; output gives its last lines; ` +
			"list shows them all with their state; stop kills one. Background commands end with the session. " +
			"Use bash for anything that finishes by itself.",
		parameters: Type.Object({
			action: StringEnum(["start", "list", "output", "stop"]),
			command: Type.Optional(Type.String({ description: "start: the command" })),
			id: Type.Optional(Type.String({ description: "output, stop: the id start gave" })),
			lines: Type.Optional(Type.Number({ description: "output: how many last lines (default 40)" })),
		}),
		async execute(_id, p) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
			const state = (r: Run) => {
				const rc = r.exitCode();
				return rc === undefined ? `running ${Math.round((Date.now() - r.startedAt) / 1000)} s` : `exited ${rc}`;
			};
			if (p.action === "start") {
				if (!p.command?.trim()) throw new Error("start: give the command");
				const run = runs.start(p.command, cwd, envOf(), "b");
				runs.background.set(run.id, run);
				await sleep(500);
				const first = tail(run, 10);
				return text(`started ${run.id} (${state(run)})${first ? `; its output so far:\n${first}` : ""}`);
			}
			if (p.action === "list") {
				if (!runs.background.size) return text("no background commands");
				return text([...runs.background.values()].map((r) => `${r.id}  ${state(r)}  ${r.command}`).join("\n"));
			}
			const run = p.id ? runs.background.get(p.id) : undefined;
			if (!run) throw new Error(`${p.action}: no background command ${p.id ?? "(no id)"}; list shows them`);
			if (p.action === "output") {
				const out = tail(run, Math.max(1, Math.min(p.lines ?? 40, 500)));
				return text(`${run.id} ${state(run)}\n${out || "(no output yet)"}`);
			}
			if (run.exitCode() === undefined) {
				run.kill();
				for (let i = 0; i < 20 && run.exitCode() === undefined; i++) await sleep(100);
			}
			return text(`${run.id} ${state(run)}`);
		},
	});
}
