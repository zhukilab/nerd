// Headless run of Pi's agent core against a local llama-server (decision 0007).
//
//   node src/run.ts <workspace-dir> "<task>" [--log events.jsonl]
//   node src/run.ts <workspace-dir> --task-file <path> [--log events.jsonl]   (run-args.ts)
//
// Environment:
//   NERD_MODE      plan | solve | ralph (src/mode.ts, process ticket 104). Unset: the plan step,
//                  then the work under Ralph, as always. plan: the plan only (a PLAN.md there is
//                  revised to the task, commit "Plan" on top), exit 0 when it is committed. solve:
//                  no plan step, no Ralph, no done gate; what is there committed before and after.
//                  ralph: a PLAN.md there is carried out under Ralph without a plan step; none, as unset
//   NERD_PROBLEM_FILE  the task from this file (relative to the workspace) when none is given
//   NERD_BASE_URL  OpenAI-compatible endpoint (default http://127.0.0.1:18091/v1)
//   NERD_MODEL     model id to report (default: whatever the server serves;
//                  for mlx-vlm's server, the model its /health says it loaded)
//   NERD_CTX       the server's context size in tokens (default: llama-server's
//                  /props, else 16384)
//   NERD_SAMPLING  sampling fields added to every request that does not set
//                  them, e.g. "temperature=0.7,top_p=0.8,top_k=20" (src/sampling.ts)
//   NERD_THINKING  off | low | medium | high (default off)
//   NERD_VERIFY_N  candidates per step for the verifier (default 1: plain loop)
//   NERD_BASH_TIMEOUT  seconds a bash call may run when the model gives no
//                  timeout (default 600; src/bash-tool.ts)
//   NERD_SPEC_CHECK=1  after the first "done", check the task text clause by
//                  clause (src/spec-check.ts); NERD_SPEC_CHECK_ROUNDS bounds the
//                  re-checks (default 3); NERD_SPEC_CHECK_SNAPSHOT=<dir> copies
//                  the workspace there before the check, for measurement
//   NERD_PLAN_STEP=0  no questions-and-plan turn before the work (src/plan-step.ts);
//                  NERD_PLAN_ANSWER answers its questions (default «на твоё усмотрение»)
//   NERD_PLAN_LINT=0  no plan-lint of the final plan (src/plan-lint.ts): placeholders,
//                  tool-call text instead of a plan, and with the Ralph loop Done when
//                  checks that cannot run, cannot fail or do not parse go back once;
//                  NERD_PLAN_MAX_TOKENS caps each reply of the step (default 6144, with
//                  thinking 24576; 0 = off); NERD_PLAN_MAX_MINUTES its wall clock (default
//                  45, 0 = off): past it the tools go away and requests go without thinking
//   NERD_REPEAT_GUARD=0  no cut of a reply that repeats one piece of text over and
//                  over (src/repeat-guard.ts; then a steer, at most twice per task)
//   NERD_LOOP_GUARD_N  repeats of one call (same arguments, same result) before
//                  the loop guard's note (default 3, 0 = off; src/loop-guard.ts)
//   NERD_FETCH_GUARD=0  no note on a web_fetch 404 for an address that no
//                  web_search result had (src/fetch-guard.ts)
//   NERD_LINT=0    no linter after write/edit (src/lint-check.ts)
//   NERD_WORK_MAX_MINUTES  the wall clock of each turn of work (default 0 = none): a
//                  note to commit and sum up, 15 min later the tools go away; a reply still
//                  streaming then is cut, the working tree committed by the harness, and a
//                  summary asked for (src/work-budget.ts)
//   NERD_CALC=1    every calculation by a program: the rule in the system prompt, and a reply
//                  computing by hand is cut and steered (src/calc-guard.ts)
//   NERD_PLAN_CALC=1  the plan step has `calc`, a Python calculator (src/plan-calc.ts);
//                  NERD_PLAN_CALC_NOTE text added to the step's prompt; NERD_PLAN_CALC_LINT=1
//                  plan-lint wants each number of a check from the task, an input, or calc
//   NERD_STEPS=1   after each commit of the model's, the plan's steps not yet done are checked by
//                  their `check:` commands in a clean clone; the result goes with the commit's
//                  output, each step done is logged as a "nerd-step" entry (src/step-log.ts)
//   NERD_DONE_GATE=0  no check of the committed project when a turn of work
//                  ends (src/done-gate.ts); NERD_DONE_GATE_ROUNDS bounds the
//                  messages it sends back per operator message (default 2)
//   NERD_RALPH=0   no Ralph loop (on by default; src/ralph.ts, decision 0014): the plan's DONE
//                  WHEN items carry check commands; after the work they run in a
//                  clean clone, and failures start a new round from the files
//                  (NERD_RALPH_ROUNDS, default 3; NERD_RALPH_MINUTES, default none);
//                  NERD_RALPH_PROGRESS=work: "no progress" is two rounds in a row with the same
//                  failures and the same committed tree (a long task; default: same failures once)
//   NERD_RALPH_GATE  a command asked before each next round and before the first turn (src/ralph-gate.ts,
//                  #978): it may say continue, continue with a turn of N minutes, or pause; a pause
//                  commits the work, saves the loop's state (NERD_RALPH_STATE, default inside .git)
//                  and exits 75. NERD_RALPH_RESUME=1 goes on from the saved state: no plan step,
//                  a new session, the round that was about to start. With either set, SIGTERM saves too
//   NERD_BASH_MAX_CHARS  a longer bash output reaches the model as head and tail,
//                  the whole of it in a file (default 8000, 0 = off; src/output-cap.ts)
//   NERD_QUIET=0   no quiet defaults (NO_COLOR, npm fund/audit, ...) for the
//                  model's commands (src/bash-tool.ts)
//   NERD_WEB_NOTES=0  no copy of each fetched web page in notes/web/ of the
//                  project (src/web-notes.ts)
//   NERD_ANCHORS=0  no anchors (task, PLAN.md, notes/, changed files) after a
//                  compaction; NERD_ANCHORS_MAX_CHARS bounds them (4000; src/anchors.ts)
//   NERD_SUMMARY_GOAL=0  the compaction summary's goal as pi-vcc wrote it, not
//                  the task (src/summary-goal.ts)
//   NERD_THINKING_KEEP=N  only the last N replies' thinking goes back to the model
//                  (default 0; all = all of it, as Pi does; src/thinking-keep.ts)
//   NERD_RULES_FILE  the operator's rules for every project (default RULES.md in
//                  the agent dir); NERD_RULES_MAX_CHARS bounds them (4000; src/rules.ts)
//   NERD_VCC_RECALL=1  offer pi-vcc's vcc_recall (off: src/packages.ts)
//   NERD_PI_VCC, NERD_WEB  Pi packages on (1) or off (0): src/packages.ts
//   NERD_SCOUT=1   the work and the plan step have `scout`: a question about the project goes
//                  to a helper session with reading tools only, its findings to notes/scout/
//                  (src/scout.ts; NERD_SCOUT_MAX_CALLS, NERD_SCOUT_MAX_MINUTES its budget)
//   NERD_SESSION_DIR  where the session file goes (default: the run's temp agent dir)
//   NERD_PLAN_BASE_URL  the ping-pong pair (src/pair.ts): the model at this endpoint
//                  writes the plan and its checks (and corrects them in the Ralph
//                  amend round), the one at NERD_BASE_URL writes the code;
//                  NERD_PLAN_MODEL its model id (default: whatever it serves)
//
// AGORA_PI_CHANNEL=<socket> (or the older NERD_AGORA_CHANNEL) connects the run to a session manager's channel
// (src/agora-channel.ts; agora's PI-CHANNEL.md): events out, letters in, send_letter.
//
// The temp agent dir (under $TMPDIR) is removed when the run ends, unless the
// session is in it (no NERD_SESSION_DIR): then its path is printed. SIGINT and
// SIGTERM abort the turn and end the run the same way (exit 130, 143).
//
// The interactive counterpart is tui.ts; what both share is in local.ts.

// First: the operator's settings file into process.env, before modules that read NERD_* at load.
import "./settings-load.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agoraChannel, agoraChannelPath, closeProcessChannel } from "./agora-channel.ts";
import { logged } from "./event-log.ts";
import { sessionStats } from "./session-stats.ts";
import { type HarnessHooks, harness } from "./harness.ts";
import { headlessSession } from "./headless.ts";
import { localModel, modelApiKey, modelDefinition, plannerModel, settingsFor, stayOffline, withVerifier } from "./local.ts";
import { CARRY_OUT, commitAll, commitPlan, headlessMode, type Mode, planCommit, solveSubject } from "./mode.ts";
import { PLANNER, type Role } from "./pair.ts";
import { PLAN_FILE, planTask } from "./plan-step.ts";
import { enabledPackages } from "./packages.ts";
import { newState, type RalphState, ralphOn, ralphOptions, runRalphHeadless } from "./ralph.ts";
import { askGate, fromSaved, gateCommand, loadRun, PAUSE_EXIT, resumeMessage, type SavedRun, saveRun, statePath, toSaved } from "./ralph-gate.ts";
import { RUN_USAGE, runArgs } from "./run-args.ts";
import { runSpecCheck } from "./spec-check.ts";
import { commitWork, WORK_GRACE_MINUTES } from "./work-budget.ts";

stayOffline();

/** Whether `file` has changes git has not committed (false outside a repository). */
function uncommitted(cwd: string, file: string): boolean {
	try {
		return execFileSync("git", ["status", "--porcelain", "--", file], { cwd, stdio: "pipe" }).toString().trim() !== "";
	} catch {
		return false;
	}
}

async function main() {
	const args = runArgs(process.argv.slice(2), process.env, true);
	if ("error" in args) {
		console.error(args.error);
		process.exit(2);
	}
	const { workspace, log: logPath } = args;
	let task = args.task;
	// The first prompt: the task, or with a plan to carry out, the ask to carry it out.
	let opening = task;
	const cwd = resolve(workspace);
	mkdirSync(cwd, { recursive: true });
	// NERD_MODE (mode.ts, process ticket 104): unset, the path as it always was.
	let mode: Mode;
	try {
		mode = headlessMode();
	} catch (e) {
		console.error((e as Error).message);
		process.exit(2);
	}
	const explicitRalph = mode === "ralph" && !!process.env.NERD_MODE?.trim();
	// #978: the round gate and the resume of a paused run (ralph-gate.ts).
	const looping = mode === "ralph" && ralphOn();
	const gate = looping ? gateCommand() : undefined;
	const resume = process.env.NERD_RALPH_RESUME === "1";
	let saved: SavedRun | undefined;
	if (resume) {
		if (!looping) {
			console.error("NERD_RALPH_RESUME=1 needs the Ralph loop: NERD_MODE unset or ralph, NERD_RALPH not 0");
			process.exit(2);
		}
		const s = loadRun(statePath(cwd));
		if ("error" in s) {
			console.error(s.error);
			process.exit(2);
		}
		saved = s;
		if (task.trim() && task.trim() !== s.task.trim()) console.log("[resume: the task given is ignored; the saved run's task goes on]");
		task = s.task;
		opening = resumeMessage(s);
	}
	// ralph with a plan there: the plan is carried out, not made again; plan: the plan step always.
	const carryOut = !resume && explicitRalph && existsSync(join(cwd, PLAN_FILE));
	const withPlanStep = mode === "plan" || (mode === "ralph" && !resume && !carryOut && process.env.NERD_PLAN_STEP !== "0");
	if (carryOut) {
		const warning = await commitPlan(cwd);
		if (warning) console.log(`[${warning}]`);
		opening = `${CARRY_OUT}${task.trim() ? `\n\n${task.trim()}` : ""}`;
		// The Ralph loop's "task in the operator's words": the one given, else the plan's own.
		if (!task.trim()) task = planTask(readFileSync(join(cwd, PLAN_FILE), "utf8")) || CARRY_OUT; // whole-read: the plan, a page
	} else if (!task.trim()) {
		console.error(RUN_USAGE);
		process.exit(2);
	}
	const local = await localModel();
	const { baseUrl, ctx, thinking, id: modelId } = local;
	const planner = await plannerModel();

	// Pi reads custom endpoints from models.json in its agent directory; keep
	// that directory private to the run so nothing leaks between runs.
	const agentDir = mkdtempSync(join(tmpdir(), "nerd-agent-"));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: { baseUrl, api: "openai-completions", apiKey: modelApiKey(), models: [modelDefinition(local)] },
				...(planner
					? { [PLANNER]: { baseUrl: planner.baseUrl, api: "openai-completions", apiKey: "none", models: [modelDefinition(planner)] } }
					: {}),
			},
		}),
	);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const model = modelRuntime.getModel("local", modelId);
	if (!model) throw new Error(`model local/${modelId} not registered`);
	const plannerAt = planner ? modelRuntime.getModel(PLANNER, planner.id) : undefined;
	if (planner && !plannerAt) throw new Error(`model ${PLANNER}/${planner.id} not registered`);

	// No operator here: the plan step answers its questions with NERD_PLAN_ANSWER.
	const hooks: HarnessHooks = {};
	const agora = agoraChannelPath();
	const verifyN = local.verifyN;
	const t0 = Date.now();
	const compactionFailures: string[] = [];
	// A session of the run. The first one has the plan step; a Ralph round in a new
	// session (NERD_RALPH_FRESH=1) has not — its task is the round's message.
	const makeSession = async (planStep: boolean) => {
		const s = await headlessSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			thinking,
			settings: settingsFor(local),
			extensions: [
				harness(false, planStep ? { ...process.env, NERD_PLAN_STEP: "1" } : { ...process.env, NERD_PLAN_STEP: "0" }, hooks),
				// A session manager's channel (agora-channel.ts): the newest session takes it over.
				...(agora ? [agoraChannel("run", agora)] : []),
			],
			// A file, so vcc_recall (NERD_PI_VCC) has something to search.
			sessionDir: process.env.NERD_SESSION_DIR ?? join(agentDir, "sessions"),
		});
		// Best-of-N with the verifier (decisions 0005, 0007): NERD_VERIFY_N=1 or
		// unset runs the plain loop.
		if (verifyN > 1) {
			s.agent.streamFunction = withVerifier(s.agent.streamFunction, local, logPath ? logPath.replace(/\.jsonl$/, "") + ".verifier.jsonl" : undefined);
		}
		s.subscribe(onEvent);
		return s;
	};

	console.log(`[model ${modelId}, context ${ctx}, thinking ${thinking}, verify N=${verifyN}, spec check ${process.env.NERD_SPEC_CHECK === "1" ? "on" : "off"}, packages ${enabledPackages().map((p) => p.name).join(" ") || "none"}]`);
	if (planner) console.log(`[pair: the plan and its checks by ${planner.id} (context ${planner.ctx}), the code by ${modelId}]`);
	const onEvent = (event: Parameters<Parameters<Awaited<ReturnType<typeof headlessSession>>["subscribe"]>[0]>[0]) => {
		// `ts` (UTC) and the Pi session's id on every line but the per-token updates (#993, agora's collector
		// #983: it dedups messages by message.responseId and needs the session on the line).
		if (logPath) {
			const stamp = event.type === "message_update" ? {} : { ts: new Date().toISOString(), session: sessionStats().session ?? null };
			appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, ...stamp, ...logged(event) })}\n`);
		}
		const ev = event as { type: string; errorMessage?: string };
		// "Nothing to compact (session too small)" is not a failure: the Ralph loop
		// compacts before each round, and a short round leaves nothing to summarise.
		if (ev.type === "compaction_end" && ev.errorMessage && /Nothing to compact/.test(ev.errorMessage)) {
			process.stdout.write(`\n[compaction skipped: ${ev.errorMessage}]\n`);
		} else if (ev.type === "compaction_end" && ev.errorMessage) {
			compactionFailures.push(ev.errorMessage);
			process.stdout.write(`\n[compaction failed: ${ev.errorMessage}]\n`);
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		} else if (event.type === "tool_execution_start") {
			process.stdout.write(`\n[tool ${event.toolName}] ${JSON.stringify(event.args).slice(0, 200)}\n`);
		} else if (event.type === "tool_execution_end") {
			process.stdout.write(`[tool ${event.toolName} done${event.isError ? ", ERROR" : ""}]\n`);
		}
	};
	let session = await makeSession(withPlanStep);
	// The Ralph loop's state: a resumed run's from the start, a new run's once the loop starts.
	let loopState: RalphState | undefined = saved ? fromSaved(saved) : undefined;
	// When the current turn of work started (the opening, then each round's prompt); undefined once the
	// loop has counted the turn in its roundsMs.
	let turnStartedAt: number | undefined = Date.now();
	// The state's last word is said (ended, or paused by the gate with its round): a signal after it saves nothing.
	let finalSaved = false;
	/** Saves the loop's state; a failure is reported, never thrown (the exit code must survive it). */
	const save = (s: RalphState, run: { reason: string; status: SavedRun["status"]; next?: string; role?: Role; partialMs?: number; stalled?: boolean }) => {
		try {
			const path = statePath(cwd);
			const roundsMs = [...(s.roundsMs ?? []), ...(run.partialMs !== undefined ? [run.partialMs] : [])];
			saveRun(path, toSaved(s, { task, reason: run.reason, status: run.status, activeMs: Date.now() - s.started, roundsMs, next: run.next, role: run.role, stalled: run.stalled }));
			return path;
		} catch (e) {
			process.stdout.write(`\n[the loop's state NOT saved (${run.status}): ${(e as Error).message}]\n`);
			return undefined;
		}
	};
	// #978: with the gate or a resume, a signal saves the loop's state, so the run can go on. A new run
	// stopped before its plan was committed is not saved: a new start makes the plan again.
	const saveOnSignal = (sig: NodeJS.Signals) => {
		if (!(gate || resume) || !looping || finalSaved) return;
		if (!loopState && !planCommit(cwd)) return;
		let sha: string | undefined;
		try {
			sha = commitWork(cwd, 0, `Work in progress at ${sig}, committed by the harness`);
		} catch {}
		const st = loopState ?? newState(turnStartedAt ?? Date.now(), ralphOptions());
		const partialMs = turnStartedAt !== undefined ? Date.now() - turnStartedAt : undefined;
		const path = save(st, { reason: `stopped by ${sig}`, status: "paused", role: st.amendable ? "planner" : "worker", partialMs });
		if (path) process.stdout.write(`[${sig}: the loop's state saved to ${path}${sha ? `, the work committed as ${sha}` : ""}; NERD_RALPH_RESUME=1 goes on]\n`);
	};
	// #993: the session's one summary line, last in the events log — at the end of the run, or
	// "complete": false when a signal or an error ends it (agora's collector then rebuilds what it
	// can from the message lines; a hard kill writes none).
	let summarised = false;
	const summarise = (complete: boolean, end: Record<string, unknown>) => {
		if (summarised || !logPath) return;
		summarised = true;
		const st = sessionStats();
		st.ralphRounds = loopState?.round ?? 0;
		try {
			appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, ...st.summary(complete, end) })}\n`);
		} catch {}
	};
	// SIGINT/SIGTERM (a manager stopping the run, docker stop): the turn is aborted and the
	// run ends as the finally below would, not with Node's default death mid-turn.
	const stop = (sig: NodeJS.Signals, code: number) => {
		process.stdout.write(`\n[${sig}: the run is stopped]\n`);
		saveOnSignal(sig);
		summarise(false, { end: `stopped by ${sig}`, exit: code });
		void session
			.abort()
			.catch(() => {})
			.finally(() => {
				session.dispose();
				if (process.env.NERD_SESSION_DIR) rmSync(agentDir, { recursive: true, force: true });
				else console.log(`[agent dir kept, the session is in it: ${agentDir}]`);
				process.exit(code);
			});
	};
	process.once("SIGINT", () => stop("SIGINT", 130));
	process.once("SIGTERM", () => stop("SIGTERM", 143));

	// A reply the repeat guard or the work clock cut ends Pi's run; its steer goes on
	// as the next prompt (repeat-guard.ts: at most twice per task; work-budget.ts).
	// A turn the loop guard ended with no steer (its third loop) stops with Pi's "aborted" error:
	// that is the guard's end of the turn, not the model server failing (#1013), so Ralph checks
	// the work and goes on, as loop-guard.ts says.
	let endedByGuard = false;
	const prompt = async (text: string) => {
		turnStartedAt = Date.now();
		endedByGuard = false;
		hooks.takeEnded?.();
		await session.prompt(text);
		for (let s = hooks.takeSteer?.(); s; s = hooks.takeSteer?.()) {
			process.stdout.write(`\n[harness: the reply was cut — ${s.slice(10, 60)}…]\n`);
			await session.prompt(s);
		}
		endedByGuard = hooks.takeEnded?.() ?? false;
		if (endedByGuard) process.stdout.write("\n[harness: the loop guard ended the turn (the same call again after two notes)]\n");
	};
	let ranThrough = false;
	try {
		// solve: what is there is committed before the work and after it (mode.ts commitAll).
		const commit = (subject: string) => {
			const r = commitAll(cwd, subject);
			if (r.committed) console.log(`\n[solve: committed "${r.committed}"]`);
			if (r.error) console.log(`\n[solve: not committed (${r.error})]`);
		};
		// The pair: the amend round goes to the checks' author (pair.ts).
		const role = plannerAt
			? async (r: Role) => {
					const m = r === "planner" ? plannerAt : model;
					if (session.model?.provider === m.provider) return;
					process.stdout.write(`\n[pair: ${r === "planner" ? `the planner (${m.id}) corrects the checks` : `back to the worker (${m.id})`}]\n`);
					await session.setModel(m);
				}
			: undefined;
		// #978: the gate is asked before the first turn too — a run started (or resumed) outside its
		// window does nothing and says so; the saved state, if any, stays as it was.
		if (gate) {
			const roundsMs = loopState?.roundsMs ?? [];
			const a = askGate(gate, {
				round: loopState?.round ?? 0,
				activeMs: roundsMs.reduce((x, y) => x + y, 0),
				roundsMs,
				budgetMs: ralphOptions().maxMs,
				failing: 0,
				cwd,
				graceMinutes: WORK_GRACE_MINUTES,
			});
			if (a.decision === "pause") {
				console.log(`\n[ralph] Paused by the gate before the run's first turn: ${a.reason}. Nothing was done.`);
				process.exitCode = PAUSE_EXIT;
				return;
			}
			hooks.turnMinutes = a.workMinutes;
			console.log(`[gate: continue${a.workMinutes ? `, the first turn ${a.workMinutes} min` : ""}${a.reason ? ` — ${a.reason}` : ""}]`);
		}
		if (saved) {
			console.log(`[resume: ${saved.reason} at ${saved.pausedAt}; round ${saved.state.round}, ${saved.next ? "the pending round goes on" : "the interrupted turn goes on"}]`);
			if (saved.role === "planner") await role?.("planner");
		}
		if (mode === "solve") commit("Before solve");
		const planBefore = planCommit(cwd);
		const planAt = join(cwd, PLAN_FILE);
		const writtenBefore = existsSync(planAt) ? statSync(planAt).mtimeMs : -1;
		const openingStarted = Date.now();
		await prompt(opening);
		if (mode === "solve") commit(solveSubject(task));
		if (mode === "plan") {
			// The plan is the run's result: done when the step saved it and it is committed —
			// a new "Plan" commit, or none because the revised plan came out the same.
			const secs = ((Date.now() - t0) / 1000).toFixed(0);
			const now = planCommit(cwd);
			const saved = existsSync(planAt) && statSync(planAt).mtimeMs !== writtenBefore;
			const notDone = (why: string) => {
				console.error(`\n[NOT DONE after ${secs} s: ${why}]`);
				process.exitCode = 1;
			};
			if (!saved) notDone("no plan saved");
			else if (now && now !== planBefore) console.log(`\n[plan done in ${secs} s: ${PLAN_FILE} committed (${now.slice(0, 7)})]`);
			else if (uncommitted(cwd, PLAN_FILE)) notDone(`${PLAN_FILE} saved but not committed: git refused (the plan step's note above says why)`);
			else console.log(`\n[plan done in ${secs} s: unchanged, the same as the last "Plan" commit]`);
			return;
		}
		// The Ralph loop (decision 0014): rounds from the files until the DONE
		// WHEN checks pass, no progress, or the budget.
		let ralphDone = false;
		let ralphStopped = false;
		if (mode === "ralph" && ralphOn()) {
			const opts = ralphOptions();
			const fresh = async () => {
				const old = session;
				session = await makeSession(false);
				old.dispose();
				process.stdout.write("\n[ralph: the round starts in a new session]\n");
			};
			const failed = () => {
				if (endedByGuard) return undefined;
				const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
				return last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage || "error" : undefined;
			};
			const guarded = { compact: (i?: string) => session.compact(i), prompt, role, fresh, failed };
			const st = loopState ?? newState(Date.now(), opts);
			loopState = st;
			const d = await runRalphHeadless(
				guarded,
				cwd,
				task,
				opts,
				(r) => {
					if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, type: "ralph_round", ...r })}\n`);
					process.stdout.write(`\n[ralph round ${r.round}/${opts.maxRounds}: ${r.kind}, ${r.failures.length} failing${r.gate ? `; gate: ${r.gate}` : ""}]\n`);
				},
				undefined,
				{
					state: st,
					turnStarted: openingStarted,
					gate: gate ? (i) => askGate(gate, i) : undefined,
					setWorkMinutes: (m) => {
						hooks.turnMinutes = m;
					},
					turnRecorded: () => {
						turnStartedAt = undefined;
					},
					onPause: (p) => {
						let sha: string | undefined;
						try {
							sha = commitWork(cwd, 0, `Work in progress at a pause of the run (${p.reason}), committed by the harness`);
						} catch {}
						const path = save(st, { reason: p.reason, status: "paused", next: p.next, role: p.role, stalled: p.stalled });
						finalSaved = !!path;
						if (path) process.stdout.write(`\n[pause: the loop's state saved to ${path}${sha ? `, the work committed as ${sha}` : ""}]\n`);
					},
				},
			);
			process.stdout.write(`\n${d.kind === "next" ? "" : d.report}\n`);
			if (d.kind === "pause") {
				console.log("[paused: NERD_RALPH_RESUME=1 goes on from here]");
				process.exitCode = PAUSE_EXIT;
				return;
			}
			// A run that may have been paused before ends its saved state, so it is not resumed again.
			if ((gate || resume) && d.kind !== "next") finalSaved = !!save(st, { reason: d.kind === "done" ? "done" : d.report.split("\n")[0], status: "ended" });
			ralphDone = d.kind === "done";
			ralphStopped = !ralphDone;
		}
		// Spec check before done (ticket 030): off unless NERD_SPEC_CHECK=1, and
		// only after a first reply that ended by itself.
		const first = session.messages.at(-1) as { role?: string; stopReason?: string };
		if (process.env.NERD_SPEC_CHECK === "1" && first?.role === "assistant" && first.stopReason === "stop") {
			const maxRounds = Number(process.env.NERD_SPEC_CHECK_ROUNDS ?? 3);
			// For measurement: the workspace as it was at the first "done".
			const snap = process.env.NERD_SPEC_CHECK_SNAPSHOT;
			if (snap) cpSync(cwd, snap, { recursive: true, filter: (p) => !p.includes("/node_modules") });
			await runSpecCheck(session, task, {
				maxRounds,
				onRound: (r) => {
					if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, type: "spec_check_round", ...r })}\n`);
					const v = r.verdict ? `${r.verdict.clauses} clauses, ${r.verdict.failed} failed` : "no verdict";
					process.stdout.write(`\n[spec check round ${r.round}/${maxRounds}: ${v}]\n`);
				},
			});
		}
		// A run can end quietly without finishing: a failed model call, a reply cut
		// at the token cap (context full), a compaction that could not summarise.
		// Only a final assistant reply that stopped by itself counts as done.
		const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
		const secs = ((Date.now() - t0) / 1000).toFixed(0);
		// Process ticket 107: a loop that stopped short of "done" (no progress, the budget,
		// nothing demonstrated) is not done, however the last reply ended; it used to exit 0.
		const why =
			last?.role !== "assistant"
				? `ended on a ${last?.role ?? "missing"} message`
				: endedByGuard
					? ralphStopped
						? "the Ralph loop stopped without its checks passing (its report above); the last turn was ended by the loop guard"
						: "loop guard ended the last turn (the same call again after two notes)"
				: last.stopReason !== "stop"
					? `last reply stopped with ${last.stopReason}${last.errorMessage ? `: ${last.errorMessage}` : ""}`
					: ralphStopped
						? "the Ralph loop stopped without its checks passing (its report above)"
						: undefined;
		// A compaction that failed on the way does not undo a finish the Ralph loop checked
		// itself (process ticket 089: exit 1, "NOT DONE … compaction failed 4x", on runs whose
		// every check had passed).
		const extra = compactionFailures.length ? `; compaction failed ${compactionFailures.length}x` : "";
		// Nor does a last reply that was cut (the token cap, the loop guard's hard step) undo it
		// (process ticket 109: a run whose checks passed exited 1, "last reply stopped with length").
		// "done" from the loop means its checks ran and passed (ralph.ts decide, process ticket 107).
		if (!ralphDone && (why || compactionFailures.length)) {
			console.error(`\n[NOT DONE after ${secs} s: ${why ?? "finished"}${extra}]`);
			process.exitCode = 1;
		} else {
			const cut = why ? `; the checks passed, though the ${why}` : "";
			console.log(`\n[done in ${secs} s, ${session.messages.length} messages${extra}${cut}]`);
		}
		ranThrough = true;
	} finally {
		summarise(ranThrough, { end: ranThrough ? "finished" : "error", exit: process.exitCode ?? (ranThrough ? 0 : 1) });
		session.dispose();
		// The open socket would keep the process alive.
		closeProcessChannel();
		if (process.env.NERD_SESSION_DIR) rmSync(agentDir, { recursive: true, force: true });
		else console.log(`[agent dir kept, the session is in it: ${agentDir}]`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
