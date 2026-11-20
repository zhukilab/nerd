// The clock gate (gate-window.ts, #978).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { minutesUntil, minuteOfDay, parseHhmm, windowDecision, windowOptions } from "../src/gate-window.ts";

const night = { start: 23 * 60, end: 7 * 60, tz: "Europe/Berlin", reserve: 25, minTurn: 20 };
// 2026-11-20 is CET, UTC+1.
const at = (utc: string) => new Date(`2026-11-20T${utc}:00Z`);

test("gate-window: the time zone is the window's, not the machine's", () => {
	assert.equal(minuteOfDay(at("22:30"), "Europe/Berlin"), 23 * 60 + 30);
	assert.equal(minuteOfDay(at("22:30"), "UTC"), 22 * 60 + 30);
	assert.equal(minuteOfDay(new Date("2026-07-01T05:00:00Z"), "Europe/Berlin"), 7 * 60, "summer time");
});

test("gate-window: inside a window over midnight, a turn of the minutes left less the reserve", () => {
	assert.deepEqual(windowDecision(at("22:00"), night), { decision: "continue", workMinutes: 455, reason: "23:00 Europe/Berlin: 480 min to 07:00, a turn of 455 min" });
	assert.deepEqual(windowDecision(at("04:00"), night), { decision: "continue", workMinutes: 95, reason: "05:00 Europe/Berlin: 120 min to 07:00, a turn of 95 min" });
	const late = windowDecision(at("05:20"), night);
	assert.equal(late.decision, "pause", "40 min left: less than 20 + 25");
	assert.match(late.reason, /06:20 Europe\/Berlin: 40 min to 07:00, less than a turn of 20 min/);
	assert.equal(windowDecision(at("05:15"), night).decision, "continue", "45 min left: a turn of 20");
	assert.match(windowDecision(at("08:00"), night).reason, /09:00 Europe\/Berlin is outside the window 23:00-07:00/);
	assert.equal(windowDecision(at("21:59"), night).decision, "pause", "22:59 local");
});

test("gate-window: the minutes left are real minutes on the nights the clocks change", () => {
	// 2026-03-29, Europe/Berlin: 02:00 CET becomes 03:00 CEST. 01:30 local is 00:30Z; 07:00 CEST is 05:00Z.
	assert.equal(minutesUntil(new Date("2026-03-29T00:30:00Z"), 7 * 60, "Europe/Berlin"), 270);
	// 2026-10-25: 03:00 CEST becomes 02:00 CET. 01:30 CEST is 23:30Z the day before; 07:00 CET is 06:00Z.
	assert.equal(minutesUntil(new Date("2026-10-24T23:30:00Z"), 7 * 60, "Europe/Berlin"), 390);
	const a = windowDecision(new Date("2026-03-29T00:30:00Z"), night);
	assert.equal(a.decision === "continue" && a.workMinutes, 245);
});

test("gate-window: a window within one day", () => {
	const day = { start: 9 * 60, end: 17 * 60, tz: "UTC", reserve: 0, minTurn: 30 };
	assert.equal(windowDecision(at("08:59"), day).decision, "pause");
	assert.deepEqual(windowDecision(at("16:00"), day), { decision: "continue", workMinutes: 60, reason: "16:00 UTC: 60 min to 17:00, a turn of 60 min" });
	assert.equal(windowDecision(at("17:00"), day).decision, "pause");
});

test("gate-window: options; the reserve follows the work clock's grace", () => {
	assert.equal(parseHhmm("7:05"), 425);
	assert.equal(parseHhmm("24:00"), undefined);
	assert.deepEqual(windowOptions(["--start", "23:00", "--end", "07:00"], { NERD_GATE_GRACE_MINUTES: "15" }), { start: 1380, end: 420, tz: undefined, reserve: 25, minTurn: 20 });
	assert.ok("error" in windowOptions(["--start", "23:00"]));
	assert.ok("error" in windowOptions(["--start", "23:00", "--end", "23:00"]));
	assert.ok("error" in windowOptions(["--start", "23:00", "--end", "07:00", "--tz", "Mars/Olympus"]));
});

test("gate-window: as a command it prints the gate's lines; bad arguments exit non-zero (a pause)", () => {
	const src = join(import.meta.dirname, "..", "src", "gate-window.ts");
	const ok = spawnSync(process.execPath, [src, "--start", "00:00", "--end", "23:59", "--tz", "UTC", "--reserve", "0", "--min-turn", "1"], { encoding: "utf8" });
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /^decision=(continue|pause)\n/);
	assert.match(ok.stdout, /reason=\d\d:\d\d UTC/);
	const bad = spawnSync(process.execPath, [src, "--start", "nope"], { encoding: "utf8" });
	assert.equal(bad.status, 2);
});
