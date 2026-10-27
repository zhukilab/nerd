// The work's wall clock, per turn (process ticket 089). 12 runs of 42 ran into the stand's
// 5 h timeout, and in 8 of them the code already passed the hidden check: the turns went on
// deliberating, re-checking and rewriting the model's own checks, and did not end, so the
// Ralph round that would have checked them came late or never. So from the first request of the
// work (the plan step has its own clock, plan-step.ts), after NERD_WORK_MAX_MINUTES a note asks
// it to commit and sum up; GRACE minutes later the tools are put away and the requests go
// without thinking, so the next reply is the summary and the turn ends. The next turn (a Ralph
// round, a remark) gets the tools back and a new clock. Off by default (0): in the TUI the
// operator is there.
//
// Process ticket 092: the clock started at the first tool result and was looked at only there,
// while one reply of Bonsai thinks for 25-86 minutes. So it starts at the work's first request,
// and a reply still streaming past budget and grace is cut (ctx.abort(), as the repeat guard
// does): its steer, the next prompt, asks for the summary with no tools and no thinking —
// headless run.ts takes it with takeSteer(), in the TUI it is sent once the reply has ended.

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CUT_PREFIX } from "./calc-guard.ts";
import { withoutThinking } from "./plan-step.ts";

export const WORK_GRACE_MINUTES = 15;
const WRITE_TOOLS = ["write", "edit", "bash"];
export const TIME_UP_STEER = "[harness] The work's time is up";

export function workMaxMinutes(env: Record<string, string | undefined> = process.env): number {
	const v = Number(env.NERD_WORK_MAX_MINUTES ?? 0);
	return Number.isFinite(v) && v > 0 ? v : 0;
}

export function wrapUpNote(minutes: number): string {
	return (
		`[harness] This turn of work has run ${minutes} minutes, its time budget. Finish now, within a few calls: ` +
		"commit what works, run the tests once, and end with a short summary — what is done, what is not."
	);
}

export function toolsAwayNote(minutes: number, committed?: string): string {
	const c = committed ? ` The harness committed your working tree as ${committed}.` : "";
	return (
		`[harness] ${minutes} minutes: the work's time is up and the tools are put away.${c} ` +
		"Reply now, without tools, with a short summary: what is done, what is not, and what you would do next."
	);
}

export function timeUpSteer(minutes: number, committed?: string): string {
	const c = committed ? ` The harness committed your working tree as ${committed}, so the checks see your code.` : "";
	return (
		`${TIME_UP_STEER} (${minutes} minutes): your reply was cut and the tools are put away.${c} ` +
		"Reply now, without tools and briefly, with a summary: what is done and committed, what is not, and what you would do next."
	);
}

/**
 * Process ticket 090, stage 3: in the Rust tax runs the first turn of work ran 105 minutes to
 * the cut in all six, and three never committed in 3-5 h; the summary after the cut has no
 * tools, and the done gate and the Ralph loop check the commit, so round after round they saw
 * the seed. So when the time is up, the harness commits the working tree itself (what is
 * untracked too, node_modules and target/ left out, as the plan step's first commit). Returns
 * the short sha, or undefined: not a repository, nothing to commit, or the commit failed.
 */
export function commitWork(cwd: string, minutes: number): string | undefined {
	const git = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", timeout: 30_000 });
	if (git("rev-parse", "--is-inside-work-tree").status !== 0) return undefined;
	if (!git("status", "--porcelain").stdout.trim()) return undefined;
	git("add", "-A", "--", ".", ":!node_modules", ":!target");
	const who = git("config", "user.name").stdout.trim() ? [] : ["-c", "user.name=nerd harness", "-c", "user.email=harness@localhost"];
	const msg = `Work in progress at the work's time budget (${minutes} min), committed by the harness`;
	if (git(...who, "commit", "-q", "--no-verify", "-m", msg).status !== 0) return undefined;
	return git("rev-parse", "--short", "HEAD").stdout.trim() || undefined;
}

export function workBudget(
	pi: ExtensionAPI,
	opts: {
		maxMinutes: number;
		workTools: string[];
		graceMinutes?: number;
		now?: () => number;
		operator?: boolean;
		/** What commits the working tree when the time is up (commitWork; a fake in tests). */
		commit?: (cwd: string, minutes: number) => string | undefined;
	},
) {
	const now = opts.now ?? Date.now;
	const commit = opts.commit ?? commitWork;
	const grace = opts.graceMinutes ?? WORK_GRACE_MINUTES;
	let startedAt: number | undefined;
	let noted = false;
	let closed = false;
	let pending: string | undefined;
	let cut = false;

	const working = () => pi.getActiveTools().some((t) => WRITE_TOOLS.includes(t));
	const close = () => {
		closed = true;
		pi.setActiveTools([]);
	};

	pi.on("before_agent_start", (event) => {
		// Our own steer after a cut: the summary turn stays without tools. A guard's steer after
		// its cut ("Your reply was cut: …", repeat-guard.ts, calc-guard.ts) goes on with the same
		// clock: it is the same turn of work, not a new one.
		const p = (event as { prompt?: string }).prompt ?? "";
		if (p.startsWith(TIME_UP_STEER) || p.startsWith(CUT_PREFIX)) return;
		startedAt = undefined;
		noted = false;
		cut = false;
		if (closed) pi.setActiveTools(opts.workTools);
		closed = false;
	});

	pi.on("tool_result", (event, ctx) => {
		if (closed || !working()) return; // the plan step, or closed
		const t = now();
		startedAt ??= t;
		const minutes = (t - startedAt) / 60_000;
		let note: string | undefined;
		if (!noted && minutes >= opts.maxMinutes) {
			noted = true;
			note = wrapUpNote(opts.maxMinutes);
		} else if (noted && minutes >= opts.maxMinutes + grace) {
			close();
			note = toolsAwayNote(Math.round(minutes), commit(ctx?.cwd || process.cwd(), Math.round(minutes)));
		}
		if (!note) return;
		return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }], structuredContent: event.structuredContent };
	});

	pi.on("before_provider_request", (event) => {
		if (!closed && working()) startedAt ??= now();
		if (!closed) return;
		const p = event.payload as Record<string, unknown> | undefined;
		return p && typeof p === "object" ? withoutThinking(p) : undefined;
	});

	pi.on("message_update", (_event, ctx) => {
		if (cut || closed || startedAt === undefined) return;
		const minutes = (now() - startedAt) / 60_000;
		if (minutes < opts.maxMinutes + grace) return;
		cut = true;
		close();
		const sha = commit(ctx?.cwd || process.cwd(), Math.round(minutes));
		pending = timeUpSteer(Math.round(minutes), sha);
		pi.appendEntry("nerd-work-budget", { cut: true, minutes: Math.round(minutes), committed: sha ?? null });
		ctx.abort();
	});

	pi.on("message_end", () => {
		if (!cut || !opts.operator || !pending) return;
		const s = pending;
		pending = undefined;
		pi.sendUserMessage(s, { deliverAs: "steer" });
	});

	return {
		/** Headless: the steer to send as the next prompt, once. */
		takeSteer(): string | undefined {
			const s = pending;
			pending = undefined;
			return s;
		},
	};
}
