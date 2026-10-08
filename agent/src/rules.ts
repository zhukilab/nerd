// The operator's rules for every project (process ticket 061): a file the
// harness keeps and hands to the model in the system prompt, written only by
// the operator's own commands. Memory the model was to keep itself (pi-memory,
// vcc_recall) went unused in measurement (ticket 049): it saved the operator's
// "for all my projects" rules once in four runs, and never looked anything up
// while working. What the harness hands over, the model has.
//
//   RULES.md     in Pi's agent dir (PI_CODING_AGENT_DIR, ~/.pi/nerd): the
//                agent's home, a volume that survives ./UP --build;
//                NERD_RULES_FILE puts it elsewhere. One rule per line, numbered.
//   /remember <text>        add a rule
//   /forget <number|text>   drop a rule (by its number, or the first that contains the text)
//   /rules                  show them
//
// The rules go into the system prompt of every turn the operator starts, up to
// NERD_RULES_MAX_CHARS (4000; what does not fit is named, not dropped silently).
// The model has no tool to write the file. A change reaches the model with the
// operator's next message.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_RULES_MAX = 4000;

export function rulesPath(env = process.env): string {
	if (env.NERD_RULES_FILE) return env.NERD_RULES_FILE;
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "nerd"), "RULES.md");
}

export function rulesMax(env = process.env): number {
	const n = Number(env.NERD_RULES_MAX_CHARS);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RULES_MAX;
}

const HEADER = "# The operator's rules for every project (/remember, /forget; the model does not write here)";

/** The rules in the file: one per numbered (or bulleted) line; other lines are ignored. */
export function readRules(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/)?.[1])
		.filter((r): r is string => !!r);
}

export function writeRules(path: string, rules: string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${HEADER}\n\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}${rules.length ? "\n" : ""}`);
}

/** Add a rule; returns its number. */
export function remember(path: string, text: string): number {
	const rule = text.replace(/\s+/g, " ").trim();
	const rules = readRules(path);
	rules.push(rule);
	writeRules(path, rules);
	return rules.length;
}

/** Drop the rule with this number, or the first containing this text; returns it, or undefined. */
export function forget(path: string, what: string): string | undefined {
	const rules = readRules(path);
	const key = what.trim();
	let i = /^\d+$/.test(key) ? Number(key) - 1 : rules.findIndex((r) => r.toLowerCase().includes(key.toLowerCase()));
	if (!key || i < 0 || i >= rules.length) i = -1;
	if (i < 0) return undefined;
	const [gone] = rules.splice(i, 1);
	writeRules(path, rules);
	return gone;
}

/** The system-prompt section for these rules, within max characters; undefined when there are none. */
export function rulesPrompt(rules: string[], max = DEFAULT_RULES_MAX): string | undefined {
	if (!rules.length) return undefined;
	const head =
		"## The operator's rules\nThe operator set these for every project. Follow them unless this task says otherwise; if a rule cannot be followed, say so.";
	let text = head;
	let kept = 0;
	for (const [i, r] of rules.entries()) {
		const line = `\n${i + 1}. ${r}`;
		if (text.length + line.length > max) break;
		text += line;
		kept++;
	}
	if (kept < rules.length) text += `\n(${rules.length - kept} more rule(s) did not fit in ${max} characters: ask the operator to shorten the list.)`;
	return text;
}

/** As a Pi extension: the rules in each turn's system prompt, and the operator's commands. */
export function rules(pi: ExtensionAPI, env = process.env) {
	const path = rulesPath(env);
	const max = rulesMax(env);

	pi.on("before_agent_start", (event) => {
		const section = rulesPrompt(readRules(path), max);
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});

	pi.registerCommand("remember", {
		description: "Add a rule for every project (RULES.md, in the system prompt from your next message)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("remember: give the rule, e.g. /remember commit messages in English, imperative", "error");
				return;
			}
			const n = remember(path, text);
			ctx.ui.notify(`rule ${n} kept in ${path}; the model sees it from your next message`, "info");
		},
	});

	pi.registerCommand("forget", {
		description: "Drop a rule: /forget <number> or /forget <text it contains>",
		handler: async (args, ctx) => {
			const gone = forget(path, args);
			if (gone === undefined) ctx.ui.notify(`forget: no rule '${args.trim()}' (see /rules)`, "error");
			else ctx.ui.notify(`dropped: ${gone}`, "info");
		},
	});

	pi.registerCommand("rules", {
		description: "Show the rules for every project (RULES.md)",
		handler: async (_args, ctx) => {
			const list = readRules(path);
			ctx.ui.notify(
				list.length ? `${path}:\n${list.map((r, i) => `${i + 1}. ${r}`).join("\n")}` : `no rules yet (${path}); add one with /remember <text>`,
				"info",
			);
		},
	});
}
