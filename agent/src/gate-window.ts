// A round gate (ralph-gate.ts, #978) by the clock: the run works inside a daily window and stops
// before its end. Each turn of work is given the minutes left, less a reserve for the work clock's
// grace and the round's checks, so even a long reply ends before the window does.
//
//   NERD_RALPH_GATE="node /opt/nerd/agent/src/gate-window.ts --start 23:00 --end 07:00 --tz Europe/Berlin"
//
//   --start, --end  HH:MM, the window; it may wrap midnight
//   --tz            an IANA time zone (default: the system's); Node carries its own time zone data,
//                   so the container needs no tzdata
//   --reserve M     minutes kept back from each turn (default: NERD_GATE_GRACE_MINUTES + 10)
//   --min-turn M    a turn shorter than this is not started: pause instead (default 20)

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface WindowOptions {
	start: number;
	end: number;
	tz?: string;
	reserve: number;
	minTurn: number;
}

export type WindowAnswer = { decision: "continue"; workMinutes: number; reason: string } | { decision: "pause"; reason: string };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function parseHhmm(s: string | undefined): number | undefined {
	const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s?.trim() ?? "");
	return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** Minutes since midnight in `tz` (or the system's zone). */
export function minuteOfDay(now: Date, tz?: string): number {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
	return get("hour") * 60 + get("minute");
}

/**
 * Real minutes from `now` to the next time the wall clock in `tz` shows `end`. Not the wall-clock
 * difference: on the night the clocks go forward, 01:30 to 07:00 is 270 minutes, not 330 (review of
 * #978). Stepped a minute at a time; at most a day and an hour of steps.
 */
export function minutesUntil(now: Date, end: number, tz?: string): number {
	const t0 = Math.floor(now.getTime() / 60_000) * 60_000;
	for (let k = 1; k <= 1500; k++) if (minuteOfDay(new Date(t0 + k * 60_000), tz) === end) return k;
	return (end - minuteOfDay(now, tz) + 1440) % 1440; // a zone that skips `end` that day: the wall clock's
}

export function windowDecision(now: Date, o: WindowOptions): WindowAnswer {
	const m = minuteOfDay(now, o.tz);
	const at = `${hhmm(m)}${o.tz ? ` ${o.tz}` : ""}`;
	const inside = o.start <= o.end ? m >= o.start && m < o.end : m >= o.start || m < o.end;
	if (!inside) return { decision: "pause", reason: `${at} is outside the window ${hhmm(o.start)}-${hhmm(o.end)}` };
	const left = minutesUntil(now, o.end, o.tz);
	const turn = left - o.reserve;
	if (turn < o.minTurn) return { decision: "pause", reason: `${at}: ${left} min to ${hhmm(o.end)}, less than a turn of ${o.minTurn} min and the reserve of ${o.reserve}` };
	return { decision: "continue", workMinutes: turn, reason: `${at}: ${left} min to ${hhmm(o.end)}, a turn of ${turn} min` };
}

export function windowOptions(argv: string[], env: Record<string, string | undefined> = process.env): WindowOptions | { error: string } {
	const flag = (n: string) => {
		const i = argv.indexOf(n);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const start = parseHhmm(flag("--start"));
	const end = parseHhmm(flag("--end"));
	if (start === undefined || end === undefined || start === end) return { error: "usage: gate-window.ts --start HH:MM --end HH:MM [--tz ZONE] [--reserve M] [--min-turn M]" };
	const tz = flag("--tz");
	if (tz) {
		try {
			new Intl.DateTimeFormat("en-GB", { timeZone: tz });
		} catch {
			return { error: `unknown time zone ${tz}` };
		}
	}
	const grace = Number(env.NERD_GATE_GRACE_MINUTES ?? 15);
	const reserve = Number(flag("--reserve") ?? (Number.isFinite(grace) ? grace : 15) + 10);
	const minTurn = Number(flag("--min-turn") ?? 20);
	if (!(reserve >= 0) || !(minTurn > 0)) return { error: "--reserve and --min-turn are minutes" };
	return { start, end, tz, reserve, minTurn };
}

function main() {
	const o = windowOptions(process.argv.slice(2));
	if ("error" in o) {
		console.error(o.error);
		process.exit(2); // a failing gate is a pause (ralph-gate.ts)
	}
	const a = windowDecision(new Date(), o);
	console.log(`decision=${a.decision}`);
	if (a.decision === "continue") console.log(`work_minutes=${a.workMinutes}`);
	console.log(`reason=${a.reason}`);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) main();
