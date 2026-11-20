// The settings registry and the operator's settings file (settings-registry.ts, settings.ts; process
// ticket 097): every NERD_* the project reads is in the registry, the file is read and written as the
// operator left it, and a value the kind does not allow is reported, not used.

import assert from "node:assert/strict";
import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { agentSettings } from "../src/settings-command.ts";
import { settingsDoc } from "../src/settings-doc.ts";
import { shown, strongest } from "../src/settings-view.ts";
import { SETTINGS } from "../src/settings-registry.ts";
import { applySettingsFile, environmentBefore, fileValues, invalid, parseLines, setLive, setting, writeSetting } from "../src/settings.ts";
import { tempDir } from "./tmp.ts";

const root = join(import.meta.dirname, "..", "..");

/** The files whose NERD_* names must all be in the registry. */
function sources(): string[] {
	const top = ["UP", "DOWN", "STATUS", "Dockerfile", "env.example", ...readdirSync(root).filter((f) => /^compose.*\.yaml$/.test(f))];
	const inDir = (d: string, re: RegExp) => readdirSync(join(root, d)).filter((f) => re.test(f)).map((f) => join(d, f));
	return [...top, ...inDir("container", /\.(sh|mjs)$/), ...inDir("tools", /\.sh$/), ...inDir("agent/src", /\.ts$/)].map((f) => join(root, f));
}

/** NERD_* names that are not settings. */
const NOT_SETTINGS = [
	"NERD_DOCKER_ARGS", // removed; ./UP refuses to start while one is set and names what replaced it
	"NERD_SERVER_DOCKER_ARGS", // the same
	"NERD_WSL_CONF", // a constant in tools/lib.sh: the /etc/wsl.conf settings install-prerequisites makes
	"NERD_KEYPROXY_TOKEN_FILE", // a constant in tools/lib.sh: var/keyproxy.token, where ./UP keeps the token
	// What the Ralph round gate is told (ralph-gate.ts gateEnv), not what it is set by.
	"NERD_GATE_ROUND",
	"NERD_GATE_ACTIVE_MINUTES",
	"NERD_GATE_LAST_ROUND_MINUTES",
	"NERD_GATE_MEAN_ROUND_MINUTES",
	"NERD_GATE_LONGEST_ROUND_MINUTES",
	"NERD_GATE_BUDGET_MINUTES",
	"NERD_GATE_FAILING",
	"NERD_GATE_GRACE_MINUTES",
	"NERD_GATE_WORKSPACE",
];

test("settings registry: every NERD_* in the code, the compose files and the tools is listed", async () => {
	const known = new Set([...NOT_SETTINGS, ...SETTINGS.flatMap((s) => (s.alias ? [s.name, s.alias] : [s.name]))]);
	const missing = new Map<string, string>();
	for (const f of sources()) {
		for await (const line of createInterface({ input: createReadStream(f) })) {
			for (const m of line.matchAll(/\bNERD_[A-Z0-9_]*[A-Z0-9]\b/g)) if (!known.has(m[0]) && !missing.has(m[0])) missing.set(m[0], f.slice(root.length + 1));
		}
	}
	assert.deepEqual([...missing].map(([n, f]) => `${n} (${f})`), []);
});

test("settings registry: names unique, defaults allowed by their kind, choices non-empty", () => {
	const seen = new Set<string>();
	for (const s of SETTINGS) {
		for (const n of [s.name, s.alias].filter(Boolean) as string[]) {
			assert.ok(!seen.has(n), `${n} twice`);
			seen.add(n);
		}
		assert.match(s.name, /^NERD_[A-Z0-9_]+$/);
		if (s.kind.type === "choice") assert.ok(s.kind.choices.length > 0, s.name);
		if (s.kind.type !== "text") assert.equal(invalid(s, s.default), undefined, `${s.name}: default ${s.default}`);
		assert.ok(s.summary.length > 10, `${s.name}: a summary`);
	}
});

test("settings file: lines with quotes, export and comments; the last line of a name wins", () => {
	const lines = parseLines('# mine\nexport NERD_THINKING="medium"\nNERD_THINKING=low\n\nNERD_NOPE=1\n');
	assert.deepEqual(lines.map((l) => [l.name, l.value]), [[undefined, undefined], ["NERD_THINKING", "medium"], ["NERD_THINKING", "low"], [undefined, undefined], ["NERD_NOPE", "1"]]);
	const { values, problems } = fileValues(lines, "agent");
	assert.equal(values.get("NERD_THINKING"), "low");
	assert.deepEqual(problems.map((p) => p.name), ["NERD_NOPE"]);
});

test("settings file: a value its kind does not allow is a problem, not a value", () => {
	const s = SETTINGS.find((x) => x.owner === "agent" && x.kind.type === "bool");
	assert.ok(s);
	const { values, problems } = fileValues(parseLines(`${s.name}=yes\n`), "agent");
	assert.equal(values.size, 0);
	assert.match(problems[0].why, /1 or 0/);
});

test("settings file: written in place, comments and order kept, duplicates folded, a line taken out", () => {
	const f = join(tempDir("nerd-settings-"), "settings.env");
	writeFileSync(f, "# my choice\nNERD_THINKING=low\nNERD_SCOUT=1\nNERD_THINKING=high\n");
	writeSetting(f, "NERD_THINKING", "medium");
	assert.equal(readFileSync(f, "utf8"), "# my choice\nNERD_THINKING=medium\nNERD_SCOUT=1\n"); // whole-read: a four-line test file
	writeSetting(f, "NERD_SCOUT", undefined);
	writeSetting(f, "NERD_RALPH", "0");
	assert.equal(readFileSync(f, "utf8"), "# my choice\nNERD_THINKING=medium\nNERD_RALPH=0\n"); // whole-read: a three-line test file
});

test("settings file: applied over the environment; setLive back to default restores the environment's", () => {
	const f = join(tempDir("nerd-settings-"), "settings.env");
	writeFileSync(f, "NERD_THINKING=high\nNERD_SCOUT=maybe\n");
	const env: Record<string, string | undefined> = { NERD_THINKING: "low" };
	const problems = applySettingsFile(env, f);
	assert.equal(env.NERD_THINKING, "high");
	assert.equal(environmentBefore.NERD_THINKING, "low");
	assert.deepEqual(problems.map((p) => p.name), ["NERD_SCOUT"]);
	setLive("NERD_THINKING", undefined, env);
	assert.equal(env.NERD_THINKING, "low");
});

test("/nerd: shown values say where they come from; the strongest need wins", () => {
	const s = setting("NERD_THINKING");
	assert.ok(s);
	assert.match(shown(s, {}, new Map()), /\(default\)$/);
	assert.equal(shown(s, { NERD_THINKING: "low" }, new Map()), "low  (environment)");
	assert.equal(shown(s, { NERD_THINKING: "low" }, new Map([["NERD_THINKING", "high"]])), "high");
	assert.ok(agentSettings(false).every((x) => x.owner === "agent" && x.level === "user"));
	const pick = (a: string) => SETTINGS.find((x) => x.apply === a);
	assert.equal(strongest([pick("turn"), pick("restart")].filter(Boolean) as never), "restart");
	assert.equal(strongest([]), undefined);
});

test("docs/SETTINGS.md is what settings-doc.ts makes of the registry", () => {
	const doc = readFileSync(join(root, "docs", "SETTINGS.md"), "utf8"); // whole-read: a generated doc of ~200 lines, compared whole
	assert.ok(doc === settingsDoc(), "docs/SETTINGS.md is stale: node agent/src/settings-doc.ts > docs/SETTINGS.md");
});
