// The operator's choice of settings, kept in a file (process ticket 097). The agent's settings live in
// ~/.config/nerd/settings.env in the container (the home volume, so they outlive a restart and a new
// image); ./UP's are the host's .env. Both are lines NAME=VALUE, # for comments, the last line of a
// name wins. /nerd in Pi and ./SETTINGS on the host edit them; a hand edit is as good.
//
// The file wins over the container's environment (compose.override.yaml, docker run -e): it is what
// /nerd shows and changes. An unknown name or a value its kind does not allow is reported loudly
// and left out, never taken as some default without a word.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Owner, type Setting, SETTINGS } from "./settings-registry.ts";

type Env = Record<string, string | undefined>;

export function settingsFile(env: Env = process.env): string {
	return env.NERD_SETTINGS_FILE || join(env.HOME || homedir(), ".config", "nerd", "settings.env");
}

const byName = new Map<string, Setting>();
for (const s of SETTINGS) {
	byName.set(s.name, s);
	if (s.alias) byName.set(s.alias, s);
}

export function setting(name: string): Setting | undefined {
	return byName.get(name);
}

/** Why `value` does not fit the setting, or undefined when it does. "" (unset) always fits. */
export function invalid(s: Setting, value: string): string | undefined {
	if (value === "") return undefined;
	const k = s.kind;
	if (k.type === "bool") return value === "0" || value === "1" ? undefined : "1 or 0";
	if (k.type === "choice") return k.choices.includes(value) ? undefined : `one of ${k.choices.join(", ")}`;
	if (k.type === "int") {
		if (!/^-?\d+$/.test(value)) return "a whole number";
		const n = Number(value);
		if (k.min !== undefined && n < k.min) return `at least ${k.min}`;
		if (k.max !== undefined && n > k.max) return `at most ${k.max}`;
	}
	return undefined;
}

export interface Line {
	text: string;
	name?: string;
	value?: string;
}

/** A settings file's lines; a NAME=VALUE line carries its name and value (quotes around the value taken off). */
export function parseLines(text: string): Line[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((t) => {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
		if (!m) return { text: t };
		let v = m[2].trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
		return { text: t, name: m[1], value: v };
	});
}

export function readLines(path: string): Line[] {
	if (!existsSync(path)) return [];
	return parseLines(readFileSync(path, "utf8")); // whole-read: a settings file of a few dozen lines
}

export interface Problem {
	name: string;
	value: string;
	why: string;
}

/** The file's values for one owner's settings (last line wins), and what was left out and why. */
export function fileValues(lines: Line[], owner: Owner): { values: Map<string, string>; problems: Problem[] } {
	const values = new Map<string, string>();
	const problems: Problem[] = [];
	for (const l of lines) {
		if (l.name === undefined || l.value === undefined) continue;
		const s = setting(l.name);
		if (!s) {
			problems.push({ name: l.name, value: l.value, why: "not a nerd setting" });
			continue;
		}
		if (s.owner !== owner) continue;
		const bad = invalid(s, l.value);
		if (bad) problems.push({ name: l.name, value: l.value, why: `wants ${bad}` });
		else values.set(s.name, l.value);
	}
	return { values, problems };
}

/** What the container's environment said before the file was applied (for /nerd to show). */
export const environmentBefore: Env = {};

/**
 * The agent's settings from the file into `env` (the file wins), at the start of the Pi process.
 * Returns the problems, which the caller reports.
 */
export function applySettingsFile(env: Env = process.env, path = settingsFile(env)): Problem[] {
	const { values, problems } = fileValues(readLines(path), "agent");
	for (const [name, value] of values) {
		if (!(name in environmentBefore)) environmentBefore[name] = env[name];
		const s = byName.get(name);
		if (s?.alias) delete env[s.alias];
		if (value === "") delete env[name];
		else env[name] = value;
	}
	return problems;
}

/**
 * Sets `name` to `value` in the file, or takes its line out when `value` is undefined. The line is
 * changed where it stands (later duplicates go), so the operator's comments and order stay.
 */
export function writeSetting(path: string, name: string, value: string | undefined): void {
	const lines = readLines(path);
	const out: string[] = [];
	let done = false;
	for (const l of lines) {
		if (l.name !== name) out.push(l.text);
		else if (!done && value !== undefined) {
			out.push(`${name}=${value}`);
			done = true;
		}
	}
	if (!done && value !== undefined) out.push(`${name}=${value}`);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, out.length ? `${out.join("\n")}\n` : "");
	renameSync(tmp, path);
}

/**
 * `name` in this process's environment as /nerd just set it: `value`, or for undefined (back to
 * the default) whatever the container's environment said before the file.
 */
export function setLive(name: string, value: string | undefined, env: Env = process.env): void {
	if (!(name in environmentBefore)) environmentBefore[name] = env[name];
	const v = value ?? environmentBefore[name];
	if (v === undefined || v === "") delete env[name];
	else env[name] = v;
}

/** Where a setting's value comes from now. */
export function source(name: string, env: Env, file: Map<string, string>): "file" | "environment" | "default" {
	if (file.has(name)) return "file";
	return env[name] !== undefined && env[name] !== "" ? "environment" : "default";
}
