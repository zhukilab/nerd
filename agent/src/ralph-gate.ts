// The round gate and the pause of a long run (ticket #978 of the agora board, nerd).
//
// A long run (a day of work over several nights) must stop and go on by something outside the
// agent — the clock, the machine's free memory, a flag file — without the operator watching for
// the end of a session. So before each next Ralph round the headless run asks a command,
// NERD_RALPH_GATE, run by `sh -c`, with the round's numbers in its environment (gateEnv):
//
//   stdout, one `key=value` a line, the rest ignored:
//     decision=continue | pause      (no decision line and exit 0: continue)
//     work_minutes=N                 with continue: the next turn of work gets N minutes
//                                    (work-budget.ts; its grace, NERD_GATE_GRACE_MINUTES, comes on top)
//     reason=<text>                  why; goes to the report and the saved state
//
// A gate that fails — exit code not 0, a timeout, an unknown decision, a work_minutes that is not
// a positive number — is a pause, said loudly: on a shared machine a run that overstays its
// window takes someone else's day, so a broken gate frees the machine rather than keeps it.
//
// On a pause the working tree is committed, the loop's state goes to a file (statePath; inside
// .git by default, so the project's tree stays clean), and run.ts exits PAUSE_EXIT. A run with
// NERD_RALPH_RESUME=1 reads the file: no plan step (the plan is committed), a new session told
// that it resumes, the round that was about to start, and the loop's budget counted in active
// time. A SIGTERM during the loop saves the state too, without a pending round: the resumed run
// then checks the files first, like any round.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RalphState } from "./ralph.ts";

/** The headless run's exit code for a pause (EX_TEMPFAIL): not done, not failed, to be resumed. */
export const PAUSE_EXIT = 75;
export const GATE_TIMEOUT_MS = 60_000;

export type GateAnswer = { decision: "continue"; workMinutes?: number; reason?: string } | { decision: "pause"; reason: string; failed?: boolean };

export interface GateInfo {
	/** The round about to start (1 for the first round after the first delivery). */
	round: number;
	/** Active time of the loop so far, pauses not counted. */
	activeMs: number;
	/** How long the rounds took, oldest first: the first delivery, then each round. */
	roundsMs: number[];
	/** The loop's budget of minutes (NERD_RALPH_MINUTES) in ms; 0: none. */
	budgetMs: number;
	/** How many checks failed in the check before this round. */
	failing: number;
	cwd: string;
	/** The work clock's grace after its budget (work-budget.ts). */
	graceMinutes: number;
}

export function gateCommand(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.NERD_RALPH_GATE?.trim() || undefined;
}

const minutes = (ms: number) => (ms / 60_000).toFixed(1);

/** The environment the gate gets on top of the run's own. */
export function gateEnv(i: GateInfo): Record<string, string> {
	const last = i.roundsMs.at(-1);
	const mean = i.roundsMs.length ? i.roundsMs.reduce((a, b) => a + b, 0) / i.roundsMs.length : undefined;
	const longest = i.roundsMs.length ? Math.max(...i.roundsMs) : undefined;
	return {
		NERD_GATE_ROUND: String(i.round),
		NERD_GATE_ACTIVE_MINUTES: minutes(i.activeMs),
		NERD_GATE_LAST_ROUND_MINUTES: last === undefined ? "" : minutes(last),
		NERD_GATE_MEAN_ROUND_MINUTES: mean === undefined ? "" : minutes(mean),
		NERD_GATE_LONGEST_ROUND_MINUTES: longest === undefined ? "" : minutes(longest),
		NERD_GATE_BUDGET_MINUTES: i.budgetMs ? minutes(i.budgetMs) : "",
		NERD_GATE_FAILING: String(i.failing),
		NERD_GATE_GRACE_MINUTES: String(i.graceMinutes),
		NERD_GATE_WORKSPACE: i.cwd,
	};
}

/** The gate's answer from its exit code and stdout (see the head of the file). */
export function parseGate(status: number | null, stdout: string, error?: string): GateAnswer {
	const fail = (why: string): GateAnswer => ({ decision: "pause", reason: `the gate failed: ${why}`, failed: true });
	if (error) return fail(error);
	if (status !== 0) return fail(status === null ? "killed (timeout?)" : `exit ${status}`);
	const kv = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const m = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (m) kv.set(m[1], m[2]);
	}
	const reason = kv.get("reason") || undefined;
	const decision = kv.get("decision") ?? "continue";
	if (decision === "pause") return { decision: "pause", reason: reason ?? "the gate said pause" };
	if (decision !== "continue") return fail(`unknown decision "${decision}"`);
	const wm = kv.get("work_minutes");
	if (wm === undefined || wm === "") return { decision: "continue", reason };
	const n = Number(wm);
	if (!Number.isFinite(n) || n <= 0) return fail(`work_minutes=${wm} is not a positive number`);
	return { decision: "continue", workMinutes: Math.max(1, Math.round(n)), reason };
}

/** Runs the gate command (sh -c) and reads its answer; never throws. */
export function askGate(cmd: string, info: GateInfo, env: Record<string, string | undefined> = process.env, timeoutMs = GATE_TIMEOUT_MS): GateAnswer {
	const r = spawnSync("sh", ["-c", cmd], {
		cwd: info.cwd,
		env: { ...env, ...gateEnv(info) },
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const err = r.error ? (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `no answer in ${Math.round(timeoutMs / 1000)} s` : r.error.message : undefined;
	const a = parseGate(r.status, r.stdout ?? "", err);
	if (a.decision === "pause" && a.failed && r.stderr?.trim()) a.reason += ` — ${r.stderr.trim().split("\n").slice(-3).join(" / ")}`;
	return a;
}

// --- the saved state -----------------------------------------------------------------------

export interface SavedRun {
	version: 1;
	status: "paused" | "ended";
	/** The task in the operator's words. */
	task: string;
	/** Why it paused (the gate's reason, or the signal). */
	reason: string;
	pausedAt: string;
	activeMs: number;
	roundsMs: number[];
	/** The round message that was about to be sent; none after a signal (the resumed run checks first). */
	next?: string;
	/** Who takes the next round with the pair (pair.ts). */
	role?: "worker" | "planner";
	state: {
		round: number;
		lastKey?: string;
		lastTree?: string;
		stalls?: number;
		failedHash: [string, string][];
		amendable?: string[];
		amendUsed?: boolean;
		amended: [string, { from: string; to: string }][];
		entryHead?: string;
		amendGuard?: boolean;
	};
}

/** Where the state goes: NERD_RALPH_STATE (relative: to the workspace), else inside the workspace's .git. */
export function statePath(cwd: string, env: Record<string, string | undefined> = process.env): string {
	const own = env.NERD_RALPH_STATE?.trim();
	if (own) return isAbsolute(own) ? own : join(cwd, own);
	const g = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", timeout: 30_000 });
	const dir = g.status === 0 ? g.stdout.trim() : "";
	return dir ? join(dir, "nerd-ralph-state.json") : join(cwd, ".nerd-ralph-state.json");
}

export function toSaved(
	state: RalphState,
	run: { task: string; reason: string; status: SavedRun["status"]; activeMs: number; roundsMs: number[]; next?: string; role?: "worker" | "planner"; now?: Date },
): SavedRun {
	return {
		version: 1,
		status: run.status,
		task: run.task,
		reason: run.reason,
		pausedAt: (run.now ?? new Date()).toISOString(),
		activeMs: run.activeMs,
		roundsMs: run.roundsMs,
		next: run.next,
		role: run.role,
		state: {
			round: state.round,
			lastKey: state.lastKey,
			lastTree: state.lastTree,
			stalls: state.stalls,
			failedHash: [...state.failedHash],
			amendable: state.amendable ? [...state.amendable] : undefined,
			amendUsed: state.amendUsed,
			amended: [...state.amended],
			entryHead: state.entryHead,
			amendGuard: state.amendGuard,
		},
	};
}

/** The loop's state back, its clock set so that the active time already spent counts. */
export function fromSaved(s: SavedRun, now = Date.now()): RalphState {
	const st = s.state;
	return {
		round: st.round,
		started: now - s.activeMs,
		lastKey: st.lastKey,
		lastTree: st.lastTree,
		stalls: st.stalls,
		failedHash: new Map(st.failedHash),
		amendable: st.amendable ? new Set(st.amendable) : undefined,
		amendUsed: st.amendUsed,
		amended: new Map(st.amended),
		entryHead: st.entryHead,
		amendGuard: st.amendGuard,
		roundsMs: [...s.roundsMs],
	};
}

/** Written whole through a temp file and a rename: a crash leaves the old state, not half a new one. */
export function saveRun(path: string, s: SavedRun): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(s, null, 1)}\n`);
	renameSync(tmp, path);
}

export function loadRun(path: string): SavedRun | { error: string } {
	if (!existsSync(path)) return { error: `no saved run at ${path}: nothing to resume` };
	let s: SavedRun;
	try {
		s = JSON.parse(readFileSync(path, "utf8")); // whole-read: the loop's state, a few KiB
	} catch (e) {
		return { error: `the saved run at ${path} does not parse: ${(e as Error).message}` };
	}
	if (s?.version !== 1 || !s.state || typeof s.task !== "string") return { error: `the saved run at ${path} is not one this version reads` };
	if (s.status === "ended") return { error: `the run saved at ${path} has ended (${s.reason}); a new task starts a new run` };
	return s;
}

/** The first prompt of a resumed run. */
export function resumeMessage(s: SavedRun): string {
	// The turns' sum: activeMs is the loop's clock, which starts after the first delivery.
	const worked = s.roundsMs.reduce((a, b) => a + b, 0);
	const head = `[ralph: resumed] The run was paused at ${s.pausedAt} (${s.reason}) after ${minutes(worked)} min of active work, and goes on now in a new session: nothing of the earlier conversation is here, and the files are what counts — the code, PLAN.md (its Done when items are the checks), notes/, git log. Read them first.`;
	return s.next
		? `${head}\nThe round that was about to start when it paused:\n\n${s.next}`
		: `${head}\nIt stopped in the middle of a turn; what was not committed is committed now by the harness if it was there. Carry on with the task: ${s.task}`;
}
