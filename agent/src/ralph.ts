// The Ralph loop (decision 0014, ticket 060 of the process): when the work of a
// task ends, the harness checks the plan's DONE WHEN items by their commands
// (done-when.ts) and the project as the done gate does; if anything fails, a
// new round starts from the files, not from the conversation: the conversation
// is compacted (pi-vcc, with the task as its goal) and the round's message
// carries the operator's words, the failures and what changed in the checks.
// It stops when everything passes, when the same failures come back twice in a
// row (no progress), or at the budget of rounds and minutes. NERD_RALPH=1 turns
// it on (off by default until measured). The TUI drives it by events; the
// headless run (run.ts) calls runRalphHeadless after its first prompt.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { changedSince, checkProject, fingerprint, sh } from "./done-gate.ts";
import { changedItems, type DoneItem, filesOf, frozenPlan, hashFiles, type ItemResult, parseDoneWhen, runDoneWhen } from "./done-when.ts";
import { PLAN_FILE } from "./plan-step.ts";

export function ralphOn(env = process.env): boolean {
	return env.NERD_RALPH === "1";
}

export interface RalphOptions {
	maxRounds: number;
	/** Wall-clock budget of the whole loop; 0: none. */
	maxMs: number;
}

export function ralphOptions(env = process.env): RalphOptions {
	const n = Number(env.NERD_RALPH_ROUNDS ?? 3);
	const m = Number(env.NERD_RALPH_MINUTES ?? 0);
	return { maxRounds: Number.isFinite(n) && n >= 0 ? n : 3, maxMs: Number.isFinite(m) && m > 0 ? m * 60_000 : 0 };
}

export interface RalphState {
	round: number;
	started: number;
	lastKey?: string;
	/** Hash of a failing check's own files, by command, at the time it failed. */
	failedHash: Map<string, string>;
}

export function newState(now = Date.now()): RalphState {
	return { round: 0, started: now, failedHash: new Map() };
}

export interface RoundCheck {
	/** One line per failure: the gate's, then the DONE WHEN items'. */
	failures: string[];
	items: ItemResult[];
	/** For the operator: edits of the checks, checks that passed after their files changed. */
	notes: string[];
	/** False when the plan has no DONE WHEN items: the loop has nothing of its own to check. */
	planned: boolean;
	/** The commit the checks ran on. */
	head?: string;
}

/**
 * What was checked, from the harness's own runs, not from the model's words
 * (after SoL-Pi's receipts): every item with its command, exit code and the
 * commit; a claim without a passing command is "not demonstrated".
 */
export function checkedReport(c: RoundCheck): string {
	const at = c.head ? ` on commit ${c.head.slice(0, 7)}` : "";
	const rows = c.items.map((i) =>
		i.ok
			? `  ✓ ${i.claim} — \`${i.cmd}\` exit 0`
			: i.cmd
				? `  ✗ ${i.claim} — \`${i.cmd}\` exit ${i.rc ?? "timeout"}: not demonstrated`
				: `  ✗ ${i.claim} — not demonstrated (${firstLine(i.why)})`,
	);
	return rows.length ? `\nChecked by the harness in a clean clone${at}:\n${rows.join("\n")}` : "";
}

const firstLine = (s: string) => s.split("\n")[0];

/** Runs the round's checks in a clean clone; updates the tamper record in `state`. */
export async function checkRound(cwd: string, state: RalphState, run = runDoneWhen): Promise<RoundCheck> {
	const frozen = parseDoneWhen((await frozenPlan(cwd)) ?? "");
	let current: DoneItem[] = [];
	try {
		current = parseDoneWhen(readFileSync(join(cwd, PLAN_FILE), "utf8"));
	} catch {}
	const notes: string[] = [];
	const edited = changedItems(frozen, current);
	if (frozen.length && edited.length) {
		notes.push(`PLAN.md's Done when differs from the plan as committed; the committed items were run. Changed or added: ${edited.map((i) => `"${i.claim}"`).join("; ")}`);
	}
	const top = (await sh("git", ["rev-parse", "--show-toplevel"], cwd, 30_000)).out.trim() || cwd;
	const items = await run(cwd, frozen);
	for (const r of items) {
		if (!r.cmd) continue;
		const files = filesOf(r.cmd, top);
		const h = files.length ? hashFiles(files, top) : "";
		const was = state.failedHash.get(r.cmd);
		if (!r.ok) {
			if (was === undefined) state.failedHash.set(r.cmd, h);
		} else if (was !== undefined && was !== h) {
			notes.push(`"${r.claim}" passes now, after its check's own files changed since it failed (${files.join(", ")}): look at that change.`);
		}
	}
	const gate = (await checkProject(cwd, await changedSince(cwd, undefined))).failures;
	// A check that is unusable itself (no command, cannot fail, does not parse)
	// is not a reason for a round: the plan is frozen, so the model cannot fix it,
	// and on the stand of ticket 060 (2026-10-09) every "no progress" stop was such
	// a check (plan-lint, ticket 065, catches them before the freeze). It stays
	// "not demonstrated" in the report.
	const unusable = items.filter((r) => !r.ok && r.unusable);
	if (unusable.length) notes.push(`Not demonstrated, the check itself is unusable (not a reason for another round): ${unusable.map((r) => `"${r.claim}" — ${firstLine(r.why)}`).join("; ")}`);
	const failures = [...gate, ...items.filter((r) => !r.ok && !r.unusable).map((r) => `Done when "${r.claim}"${r.cmd ? ` — \`${r.cmd}\`` : ""}: ${r.why}`)];
	const head = (await sh("git", ["rev-parse", "HEAD"], cwd, 30_000)).out.trim() || undefined;
	return { failures, items, notes, planned: frozen.length > 0, head };
}

export type Decision = { kind: "done" | "stop"; report: string } | { kind: "next"; message: string };

export function roundMessage(task: string, remark: string | undefined, round: number, max: number, check: RoundCheck): string {
	return `[ralph round ${round}/${max}] A new round of the same task. The conversation before it was compacted; what counts is in the files: the code, ${PLAN_FILE} (its Done when items are the checks), notes/, git log.
The task in the operator's words: ${task}${remark ? `\nThe operator's latest message: ${remark}` : ""}
The harness ran the checks in a clean clone of the last commit. These failed:
${check.failures.map((f) => `- ${f}`).join("\n")}${check.notes.length ? `\nAbout the checks: ${check.notes.join(" ")}` : ""}
Fix the project so that these pass, commit, and say done. A check is fixed by making its claim true, not by weakening the check: a changed check is reported to the operator.`;
}

export function decide(state: RalphState, check: RoundCheck, task: string, remark: string | undefined, opts: RalphOptions, now = Date.now()): Decision {
	const notes = check.notes.length ? `\n${check.notes.map((n) => `- ${n}`).join("\n")}` : "";
	if (!check.failures.length) {
		const passed = check.items.filter((i) => i.ok).length;
		const what = !check.planned
			? "the gate passes (the plan has no Done when checks)"
			: passed === check.items.length
				? `all ${check.items.length} Done when checks and the gate pass`
				: `${passed} of ${check.items.length} Done when checks and the gate pass; the rest are not demonstrated (unusable checks)`;
		return { kind: "done", report: `[ralph] Done after ${state.round} round(s): ${what}.${notes}${checkedReport(check)}` };
	}
	const key = check.failures.map(firstLine).sort().join("\n");
	const left = `\n${check.failures.map((f) => `- ${firstLine(f)}`).join("\n")}${notes}`;
	if (key === state.lastKey) return { kind: "stop", report: `[ralph] Stopped after round ${state.round}: the same checks failed twice in a row (no progress).${left}${checkedReport(check)}` };
	if (state.round >= opts.maxRounds) return { kind: "stop", report: `[ralph] Stopped: ${opts.maxRounds} round(s) used.${left}${checkedReport(check)}` };
	if (opts.maxMs && now - state.started > opts.maxMs) return { kind: "stop", report: `[ralph] Stopped: ${Math.round(opts.maxMs / 60_000)} min used.${left}${checkedReport(check)}` };
	state.round += 1;
	state.lastKey = key;
	return { kind: "next", message: roundMessage(task, remark, state.round, opts.maxRounds, check) };
}

/** Headless (run.ts): rounds after the first prompt has settled. */
export async function runRalphHeadless(
	session: { compact(i?: string): Promise<unknown>; prompt(text: string): Promise<void> },
	cwd: string,
	task: string,
	opts: RalphOptions,
	log: (r: { round: number; kind: string; failures: string[]; notes: string[] }) => void = () => {},
	check = checkRound,
): Promise<Decision> {
	const state = newState();
	for (;;) {
		const c = await check(cwd, state);
		const d = decide(state, c, task, undefined, opts);
		log({ round: state.round, kind: d.kind, failures: c.failures.map(firstLine), notes: c.notes });
		if (d.kind !== "next") return d;
		try {
			await session.compact();
		} catch {}
		await session.prompt(d.message);
	}
}

/** The TUI: rounds driven by events after the agent settles. */
export function ralph(pi: ExtensionAPI, opts: RalphOptions, check = checkRound) {
	let task = "";
	let remark: string | undefined;
	let state = newState();
	let ownTurn = false;
	let wrote = false;
	let ranBash = false;
	let startFp = "";
	let busy = false;

	pi.on("before_agent_start", async (event, ctx) => {
		const cwd = ctx.cwd || process.cwd();
		if (ownTurn) {
			ownTurn = false;
		} else if (event.prompt) {
			const first = !ctx.sessionManager
				.getBranch()
				.some((e: { type?: string; message?: { role?: string } }) => e.type === "message" && e.message?.role === "user");
			if (first || !task) {
				task = event.prompt;
				remark = undefined;
			} else remark = event.prompt;
			state = newState();
		}
		startFp = await fingerprint(cwd);
		wrote = false;
		ranBash = false;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			if (!event.isError) wrote = true;
		} else if (event.toolName === "bash") ranBash = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (busy || !task) return;
		const cwd = ctx.cwd || process.cwd();
		if (!wrote && !(ranBash && (await fingerprint(cwd)) !== startFp)) return;
		busy = true;
		try {
			const d = decide(state, await check(cwd, state), task, remark, opts);
			if (d.kind !== "next") {
				pi.sendMessage({ customType: "nerd-ralph", content: d.report, display: true });
				return;
			}
			const send = () => {
				ownTurn = true;
				pi.sendMessage({ customType: "nerd-ralph", content: d.message, display: true }, { triggerTurn: true });
			};
			ctx.compact({ onComplete: send, onError: send });
		} finally {
			busy = false;
		}
	});
}
