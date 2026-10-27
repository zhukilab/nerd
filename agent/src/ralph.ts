// The Ralph loop (decision 0014, ticket 060 of the process): when the work of a
// task ends, the harness checks the plan's DONE WHEN items by their commands
// (done-when.ts) and the project as the done gate does; if anything fails, a
// new round starts from the files, not from the conversation: the conversation
// is compacted (pi-vcc, with the task as its goal) and the round's message
// carries the operator's words, the failures and what changed in the checks.
// It stops when everything passes, when the same failures come back twice in a
// row (no progress), or at the budget of rounds and minutes; once per task, when
// only Done when checks keep failing while the tests and the gate pass, a round
// lets the model correct those checks' commands instead (amendMessage); a correction the model
// made on its own right after a check failed is taken at the next check on the same terms
// (checkRound) and uses that one amend. On by default since the acceptance run 0006r2
// (process ticket 060, 2026-10-20: the rules shown on the page by canon for the first time, every
// remark under 2 h; the first delivery twice as long); NERD_RALPH=0 turns it off. The TUI drives it
// by events; the headless run (run.ts) calls runRalphHeadless after its first prompt.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pairOn, pairSwitch, type Role } from "./pair.ts";
import { changedSince, checkProject, fingerprint, sh, taskBase } from "./done-gate.ts";
import { changedItems, type DoneItem, filesOf, frozenPlan, hashFiles, type ItemResult, parseDoneWhen, runDoneWhen } from "./done-when.ts";
import { PLAN_FILE } from "./plan-step.ts";

export function ralphOn(env = process.env): boolean {
	return env.NERD_RALPH !== "0";
}

export interface RalphOptions {
	maxRounds: number;
	/** Wall-clock budget of the whole loop; 0: none. */
	maxMs: number;
	/** NERD_RALPH_AMEND_GUARD=1: a corrected check is taken only if it also passes on the code of the first "done". */
	amendGuard?: boolean;
	/** NERD_RALPH_FRESH=1 (headless): each round in a new session instead of the compacted one. */
	fresh?: boolean;
}

export function ralphOptions(env = process.env): RalphOptions {
	const n = Number(env.NERD_RALPH_ROUNDS ?? 3);
	const m = Number(env.NERD_RALPH_MINUTES ?? 0);
	return {
		maxRounds: Number.isFinite(n) && n >= 0 ? n : 3,
		maxMs: Number.isFinite(m) && m > 0 ? m * 60_000 : 0,
		amendGuard: env.NERD_RALPH_AMEND_GUARD === "1",
		fresh: env.NERD_RALPH_FRESH === "1",
	};
}

export interface RalphState {
	round: number;
	started: number;
	lastKey?: string;
	/** Hash of a failing check's own files, by command, at the time it failed. */
	failedHash: Map<string, string>;
	/** The claims whose command the model may correct in the current round (the amend round). */
	amendable?: Set<string>;
	/** Whether the one amend round of the task has been given. */
	amendUsed?: boolean;
	/** Commands corrected in the amend round, by claim: they replace the frozen ones from then on. */
	amended: Map<string, { from: string; to: string }>;
	/** The commit of the first check, the work's first "done", before any round changed the code. */
	entryHead?: string;
	/** See RalphOptions.amendGuard. */
	amendGuard?: boolean;
}

export function newState(now = Date.now(), opts?: Pick<RalphOptions, "amendGuard">): RalphState {
	return { round: 0, started: now, failedHash: new Map(), amended: new Map(), amendGuard: opts?.amendGuard };
}

export interface RoundCheck {
	/** One line per failure: the gate's, then the DONE WHEN items'. */
	failures: string[];
	/** The gate's failures alone (the project's tests and the done gate). */
	gate?: string[];
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
			: i.cmd && !i.unusable
				? `  ✗ ${i.claim} — \`${i.cmd}\` exit ${i.rc ?? "timeout"}: not demonstrated`
				: i.cmd
					? `  ✗ ${i.claim} — \`${i.cmd}\` not run: not demonstrated (${firstLine(i.why)})`
					: `  ✗ ${i.claim} — not demonstrated (${firstLine(i.why)})`,
	);
	return rows.length ? `\nChecked by the harness in a clean clone${at}:\n${rows.join("\n")}` : "";
}

const firstLine = (s: string) => s.split("\n")[0];

/** Runs the round's checks in a clean clone; updates the tamper record in `state`. */
export async function checkRound(cwd: string, state: RalphState, run = runDoneWhen): Promise<RoundCheck> {
	let frozen = parseDoneWhen((await frozenPlan(cwd)) ?? "");
	let current: DoneItem[] = [];
	try {
		current = parseDoneWhen(readFileSync(join(cwd, PLAN_FILE), "utf8"));
	} catch {}
	const notes: string[] = [];
	// The amend round (decide): a command the model corrected in PLAN.md for one of
	// the claims it was offered, the claim's words kept, replaces the frozen one for good.
	if (state.amendable) {
		for (const f of frozen) {
			if (!f.cmd || !state.amendable.has(f.claim)) continue;
			const to = current.find((c) => c.claim === f.claim && c.cmd && c.cmd !== f.cmd)?.cmd;
			if (!to) continue;
			// Ticket 083 of the process: in one run a wrong check made the coder break
			// code that passed the external check, and the planner's correction then
			// fitted the broken code. A correction is about a check that was wrong about
			// the code, so it must also pass on the code before the rounds changed it.
			if (state.amendGuard && state.entryHead) {
				const [r] = await run(cwd, [{ ...f, cmd: to }], undefined, state.entryHead);
				if (!r?.ok) {
					notes.push(`"${f.claim}": the corrected check was not taken — \`${to}\` fails on the code of the first "done" (${state.entryHead.slice(0, 7)}), so it fits code changed during the rounds rather than the task; the committed check stays.`);
					continue;
				}
			}
			state.amended.set(f.claim, { from: f.cmd, to });
		}
		state.amendable = undefined;
	}
	frozen = frozen.map((f) => {
		const a = state.amended.get(f.claim);
		return a ? { ...f, cmd: a.to } : f;
	});
	for (const [claim, a] of state.amended) notes.push(`"${claim}": its check was corrected by the model after the tests passed — was \`${a.from}\`, now \`${a.to}\`.`);
	const edited = changedItems(frozen, current);
	if (frozen.length && edited.length) {
		notes.push(`PLAN.md's Done when differs from the plan as committed; the committed items were run. Changed or added: ${edited.map((i) => `"${i.claim}"`).join("; ")}`);
	}
	const top = (await sh("git", ["rev-parse", "--show-toplevel"], cwd, 30_000)).out.trim() || cwd;
	const items = await run(cwd, frozen);
	const failedBefore = new Set(state.failedHash.keys());
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
	const gate = (await checkProject(cwd, await changedSince(cwd, undefined), await taskBase(cwd))).failures;
	// A correction made before the amend round is taken at once (process ticket 089): the model
	// fixed a wrong check in PLAN.md right after it failed, the edit was only reported, the round
	// went on against the old command, and the amend round — given only after a second identical
	// failure — quoted the old command while the file held the new one; two runs spent their last
	// 2.5 h there. Taken on the amend round's own terms: the tests and the gate pass, the committed
	// command failed in an earlier check, the claim's words are kept, the new command passes on
	// this commit (and, with the guard, on the code of the first "done"). It uses the task's one amend.
	if (!state.amendUsed && gate.length === 0) {
		for (let k = 0; k < items.length; k++) {
			const r = items[k];
			if (r.ok || r.unusable || !r.cmd || !failedBefore.has(r.cmd)) continue;
			const to = current.find((c) => c.claim === r.claim && c.cmd && c.cmd !== r.cmd)?.cmd;
			const f = frozen.find((x) => x.claim === r.claim);
			if (!to || !f) continue;
			const [now] = await run(cwd, [{ ...f, cmd: to }]);
			if (!now?.ok) continue;
			if (state.amendGuard && state.entryHead) {
				const [then] = await run(cwd, [{ ...f, cmd: to }], undefined, state.entryHead);
				if (!then?.ok) {
					notes.push(`"${r.claim}": the corrected check was not taken — \`${to}\` fails on the code of the first "done" (${state.entryHead.slice(0, 7)}), so it fits code changed during the rounds rather than the task; the committed check stays.`);
					continue;
				}
			}
			state.amended.set(r.claim, { from: r.cmd, to });
			notes.push(`"${r.claim}": its check was corrected by the model after the tests passed — was \`${r.cmd}\`, now \`${to}\`.`);
			items[k] = now;
			state.amendUsed = true;
		}
	}
	// A check that is unusable itself (no command, cannot fail, does not parse)
	// is not a reason for a round: the plan is frozen, so the model cannot fix it,
	// and on the stand of ticket 060 (2026-10-09) every "no progress" stop was such
	// a check (plan-lint, ticket 065, catches them before the freeze). It stays
	// "not demonstrated" in the report.
	const unusable = items.filter((r) => !r.ok && r.unusable);
	if (unusable.length) notes.push(`Not demonstrated, the check itself is unusable (not a reason for another round): ${unusable.map((r) => `"${r.claim}" — ${firstLine(r.why)}`).join("; ")}`);
	const failures = [...gate, ...items.filter((r) => !r.ok && !r.unusable).map((r) => `Done when "${r.claim}"${r.cmd ? ` — \`${r.cmd}\`` : ""}: ${r.why}`)];
	const head = (await sh("git", ["rev-parse", "HEAD"], cwd, 30_000)).out.trim() || undefined;
	state.entryHead ??= head;
	return { failures, gate, items, notes, planned: frozen.length > 0, head };
}

export function amendMessage(task: string, round: number, max: number, check: RoundCheck): string {
	return `[ralph round ${round}/${max}] The project's tests and the gate pass, but these Done when checks failed twice in a row:
${check.failures.map((f) => `- ${f}`).join("\n")}
The task in the operator's words: ${task}
A check can be wrong about the code rather than the code wrong: the module's path or the shape of its export, a value compared the wrong way (=== between arrays or objects is always false), words a test runner does not print (node --test prints "# pass", not "passing"), an expectation the task does not ask for or contradicts (the task outranks the check). Run each check and read its output. Then, for each:
- if its claim is false, fix the code;
- if the check is wrong, correct its command in ${PLAN_FILE}: keep the claim's words exactly and change only the command, so that it passes on correct code and still fails when the claim is false. This is allowed once, in this round only; the old and the new command go to the operator.
Commit, and say in one line per corrected check why it was wrong.`;
}

export type Decision = { kind: "done" | "stop"; report: string } | { kind: "next"; message: string };

export function roundMessage(task: string, remark: string | undefined, round: number, max: number, check: RoundCheck, fresh = false): string {
	const before = fresh
		? "This is a new session: nothing of the earlier conversation is here, and nothing in it is to be trusted over the files. Read them first"
		: "The conversation before it was compacted";
	return `[ralph round ${round}/${max}] A new round of the same task. ${before}; what counts is in the files: the code, ${PLAN_FILE} (its Done when items are the checks), notes/, git log.
The task in the operator's words: ${task}${remark ? `\nThe operator's latest message: ${remark}` : ""}
The harness ran the checks in a clean clone of the last commit. These failed:
${check.failures.map((f) => `- ${f}`).join("\n")}${check.notes.length ? `\nAbout the checks: ${check.notes.join(" ")}` : ""}
Fix the project so that these pass, commit, and say done. A check is fixed by making its claim true, not by weakening the check: a changed check is reported to the operator.
The task outranks the checks: where a check expects what the task contradicts, the check is wrong, not the task. Keep the code to the task and say which check is wrong and why; never change the code against the task to make a check pass.`;
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
	// The fourth A/B of ticket 060 (2026-10-10): 5 of 6 "no progress" stops were
	// checks wrong about the code (export shape, === on arrays, runner wording)
	// while the task passed. So once per task, when the tests and the gate pass and
	// only Done when checks keep failing, the model may correct those commands
	// (decision 0014, addendum of 2026-10-11); the change goes to the operator.
	const wrong = check.items.filter((i) => !i.ok && !i.unusable && i.cmd);
	const inBudget = state.round < opts.maxRounds && !(opts.maxMs && now - state.started > opts.maxMs);
	if (key === state.lastKey && !state.amendUsed && check.gate?.length === 0 && wrong.length && inBudget) {
		state.amendUsed = true;
		state.amendable = new Set(wrong.map((i) => i.claim));
		state.round += 1;
		return { kind: "next", message: amendMessage(task, state.round, opts.maxRounds, check) };
	}
	if (key === state.lastKey) return { kind: "stop", report: `[ralph] Stopped after round ${state.round}: the same checks failed twice in a row (no progress).${left}${checkedReport(check)}` };
	if (state.round >= opts.maxRounds) return { kind: "stop", report: `[ralph] Stopped: ${opts.maxRounds} round(s) used.${left}${checkedReport(check)}` };
	if (opts.maxMs && now - state.started > opts.maxMs) return { kind: "stop", report: `[ralph] Stopped: ${Math.round(opts.maxMs / 60_000)} min used.${left}${checkedReport(check)}` };
	state.round += 1;
	state.lastKey = key;
	return { kind: "next", message: roundMessage(task, remark, state.round, opts.maxRounds, check, opts.fresh) };
}

/**
 * Headless (run.ts): rounds after the first prompt has settled. With the
 * ping-pong pair (pair.ts) `role` gives the amend round to the checks' author,
 * the planner, and everything else to the worker. With opts.fresh and
 * `fresh` each round starts in a new session (ticket 085 of the process: the
 * old conversation is where the model already convinced itself it was done).
 */
export async function runRalphHeadless(
	session: { compact(i?: string): Promise<unknown>; prompt(text: string): Promise<void>; role?(r: Role): Promise<void>; fresh?(): Promise<void> },
	cwd: string,
	task: string,
	opts: RalphOptions,
	log: (r: { round: number; kind: string; failures: string[]; notes: string[] }) => void = () => {},
	check = checkRound,
): Promise<Decision> {
	const state = newState(Date.now(), opts);
	const fresh = opts.fresh && session.fresh ? session.fresh.bind(session) : undefined;
	const d0 = { ...opts, fresh: !!fresh };
	for (;;) {
		const c = await check(cwd, state);
		const d = decide(state, c, task, undefined, d0);
		log({ round: state.round, kind: d.kind, failures: c.failures.map(firstLine), notes: c.notes });
		if (d.kind !== "next") {
			await session.role?.("worker");
			return d;
		}
		// A new session starts on the worker's model, so the role comes after it.
		if (fresh) await fresh();
		else {
			try {
				await session.compact();
			} catch {}
		}
		await session.role?.(state.amendable ? "planner" : "worker");
		await session.prompt(d.message);
	}
}

/** The TUI: rounds driven by events after the agent settles. */
export function ralph(pi: ExtensionAPI, opts: RalphOptions, check = checkRound) {
	let task = "";
	let remark: string | undefined;
	let state = newState(Date.now(), opts);
	let ownTurn = false;
	let wrote = false;
	let ranBash = false;
	let startFp = "";
	let busy = false;
	const role = pairOn() ? pairSwitch(pi) : undefined;

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
			state = newState(Date.now(), opts);
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
			// The TUI keeps its one session: rounds compact it (NERD_RALPH_FRESH is headless only).
			const d = decide(state, await check(cwd, state), task, remark, { ...opts, fresh: false });
			await role?.(d.kind === "next" && state.amendable ? "planner" : "worker", ctx);
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
