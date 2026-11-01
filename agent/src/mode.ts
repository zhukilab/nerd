// The TUI's modes (process ticket 104, decision 0019). The operator: nerd turned
// even "Hi! How are you?" into a task, because the first message of a session
// always went to the plan step (ticket 043). Now, with an operator, a session
// starts in conversation, and the work starts only on the operator's word:
//
//   talk    the default: an answer in words, reading allowed, no plan, no
//           commit, no Ralph; a task seen in the message is offered as
//           /plan, /solve or /ralph, not started
//   plan    /plan [text]: the questions-and-plan step (plan-step.ts), PLAN.md
//           committed, then a stop; each next message revises the plan (a PLAN.md
//           there already is revised, not written anew; commit "Plan" on top) —
//           the joint plan, until /solve, /ralph or /talk
//   solve   /solve [text]: the work as the model sees fit, no plan step, no
//           Ralph, no done gate; the operator is the checker. The harness
//           commits whatever is uncommitted when a cycle starts and when it ends
//   ralph   /ralph [text]: PLAN.md carried out under the Ralph loop and the
//           done gate; refused without a PLAN.md ("no plan — no DONE WHEN")
//
// /task keeps its old meaning: the plan step, then the work under Ralph. A remark
// stays in the mode it is sent in; /talk goes back to conversation.
// Headless (no operator), NERD_MODE picks the mode for the whole run (run.ts): unset,
// the path as it always was (the plan step, then Ralph); plan — the plan, revised if
// PLAN.md is there, and the end; solve — the work with no plan step and no Ralph,
// committed before and after; ralph — PLAN.md carried out if it is there, else as unset.
// The task: the argument, else NERD_PROBLEM_FILE, else NERD_TASK (container/entrypoint.sh).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { frozenPlan } from "./done-when.ts";
import { insideRepo, letterIsTask } from "./plan-step.ts";

export type Mode = "talk" | "plan" | "solve" | "ralph";

export interface ModeState {
	mode: Mode;
	/** The next prompt starts a new task of the Ralph loop (/ralph, /task), not a remark; ralph.ts clears it. */
	fresh?: boolean;
}

export const HEADLESS_MODES = ["plan", "solve", "ralph"] as const;

/** NERD_MODE of a headless run; unset is ralph, the old whole path. */
export function headlessMode(env: Record<string, string | undefined> = process.env): Mode {
	const m = (env.NERD_MODE ?? "").trim();
	if (!m) return "ralph";
	if ((HEADLESS_MODES as readonly string[]).includes(m)) return m as Mode;
	throw new Error(`NERD_MODE=${m}: one of ${HEADLESS_MODES.join(", ")} (or unset)`);
}

/** The mode of a new session: conversation with an operator; without one, NERD_MODE. */
export function newModeState(operator: boolean, env: Record<string, string | undefined> = process.env): ModeState {
	return { mode: operator ? "talk" : headlessMode(env) };
}

/** Whether the Ralph loop and the done gate act in this mode (/task's work is ralph too). */
export function checkedMode(s: ModeState): boolean {
	return s.mode === "ralph";
}

// Bonsai 2, 2026-10-30 (process ticket 104): without "the operator's language" two Russian
// questions were answered in English, the note's language; the modes were listed after "Hi!" too.
export const TALK_NOTE = `[harness] Conversation. Answer the operator in words, in the operator's language; you may read files, not change them, and there is no plan to write.
If the message asks for work to be done, do not start it: say in a few lines how you would go about it, and offer the operator a mode (only then; a greeting or a question gets just its answer):
- /plan — a plan in PLAN.md and nothing more, for the operator to read;
- /solve — you do it as you see fit, the operator checks the result;
- /ralph — PLAN.md carried out with its DONE WHEN checks (needs a plan first).`;

export const NO_PLAN_FOR_RALPH = "ralph: no PLAN.md here — no plan, no DONE WHEN to check. Make one with /plan first.";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

function why(e: unknown): string {
	const s = e instanceof Error ? (e as { stderr?: Buffer }).stderr?.toString().trim() || e.message : String(e);
	return s.split("\n")[0];
}

/** A repository is made only where there is none: in a subdirectory of one, the commits go to that one. */
function ensureRepo(cwd: string): void {
	if (!insideRepo(cwd)) git(cwd, "init", "-q");
}

/** What a /solve commit leaves out, at any depth. */
const LEFT_OUT = [":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/target/**"];

/**
 * Commits what is uncommitted under `cwd` (the /solve cycle's start and end), a repository made if
 * there is none; node_modules and target are left out. `committed` is the subject, absent when there
 * was nothing to commit; `error` is git's first line when it refused (no user.name, say).
 */
export function commitAll(cwd: string, subject: string): { committed?: string; error?: string } {
	try {
		ensureRepo(cwd);
		git(cwd, "add", "-A", "--", ".", ...LEFT_OUT);
		if (!git(cwd, "diff", "--cached", "--name-only", "--", ".").trim()) return {};
		git(cwd, "commit", "-q", "-m", subject, "--", ".", ...LEFT_OUT);
		return { committed: subject };
	} catch (e) {
		return { error: why(e) };
	}
}

/**
 * Commits PLAN.md as "Plan" for /ralph: the Ralph loop checks the plan of the last commit so named
 * (done-when.ts frozenPlan). Returns what the operator should know: a refusal of git, or a PLAN.md
 * committed under another name, so that the loop would check an older plan.
 */
export async function commitPlan(cwd: string): Promise<string | undefined> {
	try {
		ensureRepo(cwd);
		git(cwd, "add", "--", "PLAN.md");
		if (git(cwd, "diff", "--cached", "--name-only", "--", "PLAN.md").trim()) {
			git(cwd, "commit", "-q", "-m", "Plan", "--", "PLAN.md");
			return undefined;
		}
	} catch (e) {
		return `ralph: PLAN.md not committed (${why(e)}); the checks are those of the last "Plan" commit, if any`;
	}
	const now = readFileSync(join(cwd, "PLAN.md"), "utf8"); // whole-read: the plan, a page
	if ((await frozenPlan(cwd)) === now) return undefined;
	return 'ralph: PLAN.md is committed, but not as "Plan": the loop checks the last "Plan" commit. Commit PLAN.md with the message Plan to have this one checked.';
}

/** The last commit "Plan" (savePlan's) under `cwd`, its sha; undefined when there is none. */
export function planCommit(cwd: string): string | undefined {
	try {
		return git(cwd, "log", "-1", "--format=%H", "--grep=^Plan$", "--", "PLAN.md").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** What /ralph (and a headless NERD_MODE=ralph with a PLAN.md there) asks of the model. */
export const CARRY_OUT = "Carry out the plan in PLAN.md step by step, checking each step as it says.";

/** The subject of the commit that ends a /solve cycle: the operator's words, one line (a problem file's heading skipped). */
export function solveSubject(prompt: string): string {
	const lines = prompt.split("\n").map((l) => l.trim());
	const line = lines.find((l) => l && !l.startsWith("#")) ?? lines.find((l) => l) ?? "";
	return `Solve: ${line.length > 60 ? `${line.slice(0, 57)}...` : line}`;
}

/** The plan step as the modes see it (plan-step.ts); filled in once the step is registered. */
export interface PlanStepHandle {
	markTask?: () => void;
	cancel?: () => void;
	asking?: () => boolean;
}

type Ctx = { isIdle(): boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

/**
 * The modes as a Pi extension: the commands, the talk turn's tools and note, the /solve
 * commits. Registered before the Ralph loop and the plan step: a turn's tools set here are
 * the plan step's to take for a new task.
 */
export function modes(pi: ExtensionAPI, state: ModeState, opts: { planTools: string[]; workTools: string[]; step: PlanStepHandle }) {
	let solvePrompt = "";
	// The work's tools are given back when a mode of work is entered, not on every turn:
	// an answer to the plan step's questions is a turn of the step, with its reading tools.
	let entering = false;
	// A command while the agent works would switch the mode under the running turn, and its
	// message would join that turn without a start of its own (a follow-up): refused instead.
	const busy = (name: string, ctx: Ctx) => {
		if (ctx.isIdle()) return false;
		ctx.ui.notify(`${name}: the agent is working; send it again when it is done (Esc stops it)`, "warning");
		return true;
	};
	const enter = (mode: Mode) => {
		opts.step.cancel?.();
		state.mode = mode;
		entering = mode === "solve" || mode === "ralph";
	};
	// The operator's messages in talk since the last command of work. A bare /plan or /solve
	// carries them: its task is what was discussed, and PLAN.md quotes the task (Bonsai 2,
	// 2026-10-31: a bare /plan left "Make the plan for what we discussed." as the plan's task).
	let talked: string[] = [];
	const discussed = (ask: string) => {
		const said = talked;
		talked = [];
		return said.length ? `${ask}:\n\n${said.map((s) => `- ${s.trim().replace(/\n/g, "\n  ")}`).join("\n")}` : `${ask}.`;
	};

	pi.registerCommand("talk", {
		description: "Back to conversation: answers in words, nothing changed (ticket 104)",
		handler: async (args, ctx) => {
			if (busy("talk", ctx)) return;
			enter("talk");
			if (args.trim()) pi.sendUserMessage(args.trim());
			else ctx.ui.notify("talk: conversation; /plan, /solve or /ralph to work", "info");
		},
	});
	pi.registerCommand("plan", {
		description: "Questions and a plan in PLAN.md, then stop (ticket 104)",
		handler: async (args, ctx) => {
			if (!opts.step.markTask) {
				ctx.ui.notify("plan: the plan step is off (NERD_PLAN_STEP=0)", "error");
				return;
			}
			if (busy("plan", ctx)) return;
			enter("plan");
			opts.step.markTask();
			pi.sendUserMessage(args.trim() || discussed("Make the plan for what we discussed"));
		},
	});
	pi.registerCommand("solve", {
		description: "Do the task as you see fit, no plan step and no Ralph; the operator checks (ticket 104)",
		handler: async (args, ctx) => {
			if (busy("solve", ctx)) return;
			enter("solve");
			pi.sendUserMessage(args.trim() || discussed("Do what we agreed on"));
		},
	});
	pi.registerCommand("ralph", {
		description: "Carry out PLAN.md under the Ralph loop and its DONE WHEN checks (ticket 104)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd || process.cwd();
			if (!existsSync(join(cwd, "PLAN.md"))) {
				ctx.ui.notify(NO_PLAN_FOR_RALPH, "error");
				return;
			}
			if (busy("ralph", ctx)) return;
			const warning = await commitPlan(cwd);
			if (warning) ctx.ui.notify(warning, "warning");
			enter("ralph");
			state.fresh = true;
			const extra = args.trim();
			pi.sendUserMessage(`${CARRY_OUT}${extra ? `\n\n${extra}` : ""}`);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		// A letter with a task (agora-channel.ts, subject "task:") is /task: the plan step takes it.
		if (letterIsTask(event.prompt)) {
			opts.step.cancel?.();
			Object.assign(state, { mode: "ralph", fresh: true });
			entering = false;
			return;
		}
		if (state.mode === "talk") {
			talked.push(event.prompt);
			pi.setActiveTools(opts.planTools);
			return { message: { customType: "nerd-mode", content: TALK_NOTE, display: false } };
		}
		talked = [];
		// The joint plan (process ticket 104): after /plan each message revises PLAN.md, unless it
		// answers the step's questions; the plan step comes after this and takes it.
		if (state.mode === "plan" && !opts.step.asking?.()) opts.step.markTask?.();
		if (entering) {
			entering = false;
			pi.setActiveTools(opts.workTools);
		}
		if (state.mode === "solve") {
			solvePrompt = event.prompt;
			const r = commitAll(ctx.cwd || process.cwd(), "Before solve");
			if (r.error) ctx.ui.notify(`solve: the work so far is not committed (${r.error})`, "warning");
		}
		return;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (state.mode !== "solve" || !solvePrompt) return;
		const r = commitAll(ctx.cwd || process.cwd(), solveSubject(solvePrompt));
		solvePrompt = "";
		if (r.committed) ctx.ui.notify(`solve: committed "${r.committed}"`, "info");
		if (r.error) ctx.ui.notify(`solve: not committed (${r.error})`, "warning");
	});
}

