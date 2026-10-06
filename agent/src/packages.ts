// Pi packages from npm (ticket 040), pinned in package.json and loaded by
// Pi's own extension loader (jiti: their sources import extensionless paths
// that plain Node does not resolve) from this agent's node_modules, never
// fetched at run time. Each one is switched by an environment variable.
//
//   NERD_PI_VCC=1|0  @sting8k/pi-vcc (on by default): compaction without a
//                    model call. The summary is extracted, not written: goal,
//                    files, commits, open items, a brief transcript; it is
//                    bounded and cannot fail on a token cap. Plus the tool
//                    vcc_recall, which searches the session file for what
//                    compaction dropped. In the A/B of ticket 040 (four hours,
//                    64K, the same long task): Pi's own compaction took 46 of
//                    229 minutes, each one 2 to 12 minutes and growing with
//                    its summary; pi-vcc's took no measurable time. Cost:
//                    vcc_recall's schema, ~420 tokens in every request.
//
//   NERD_WEB=1|0     @juicesharp/rpiv-web-tools (on by default, ticket 041):
//                    web_search through the SearXNG the entrypoint starts in
//                    the container (SEARXNG_URL; no cloud provider, no key)
//                    and web_fetch, a page as text. web_fetch refuses
//                    loopback and private addresses: the agent's own app is
//                    checked with `browse`. The package's guidance is
//                    replaced by a shorter one (webToolsConfig). Both tools
//                    only read, so the plan step has them too.
//
// rpiv-todo (a task list tool) was measured and left out: +520 tokens in
// every request, statuses kept, but the model never read the list back after
// a compaction; the plan step's PLAN.md does that job.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PiPackage {
	flag: string;
	name: string;
	/** Tools it registers: the harness must keep them active. */
	tools: string[];
	/** Of those, the ones that change nothing: the plan step may use them. */
	readOnly?: string[];
	on: boolean;
}

export const PI_PACKAGES: PiPackage[] = [
	{ flag: "NERD_PI_VCC", name: "@sting8k/pi-vcc", tools: ["vcc_recall"], on: true },
	{
		flag: "NERD_WEB",
		name: "@juicesharp/rpiv-web-tools",
		tools: ["web_search", "web_fetch"],
		readOnly: ["web_search", "web_fetch"],
		on: true,
	},
];

const modules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");

export function enabledPackages(env = process.env): PiPackage[] {
	return PI_PACKAGES.filter((p) => (env[p.flag] === undefined || env[p.flag] === "" ? p.on : env[p.flag] === "1"));
}

/** Directories of the enabled packages, for Pi's extension loader (-e, additionalExtensionPaths). */
export function packagePaths(env = process.env): string[] {
	return enabledPackages(env).map((p) => join(modules, p.name));
}

export function packageTools(env = process.env): string[] {
	return enabledPackages(env).flatMap((p) => p.tools);
}

export function packageReadOnlyTools(env = process.env): string[] {
	return enabledPackages(env).flatMap((p) => p.readOnly ?? []);
}

/**
 * rpiv-web-tools' settings. Provider and URL come from the environment
 * (WEB_SEARCH_PROVIDER, SEARXNG_URL; the entrypoint sets both); the file
 * carries only the guidance the model reads, shorter than the package's own
 * (five lines on Sources sections, API keys and /web-tools that do not apply
 * here).
 */
export function webToolsConfig() {
	return {
		provider: "searxng",
		guidance: {
			web_search: {
				promptSnippet: "Search the web: titles, URLs and snippets",
				promptGuidelines: [
					"For facts outside your knowledge and the workspace (rules of a game, a format, a library's API): web_search, then web_fetch the best result and work from what the page says.",
					"Name the URL a fact came from: in a code comment or the README where the fact is used.",
				],
			},
			web_fetch: {
				promptSnippet: "Read a web page as text (not localhost: use browse for your own app)",
				promptGuidelines: [
					"A long page is cut; the rest is in the file named at its end, readable with read or grep.",
				],
			},
		},
	};
}

/**
 * web_search takes an optional `provider` argument, and the model fills it in:
 * in the A/B of ticket 048, after a SearXNG error it tried brave, tavily,
 * perplexity — all without keys, so they failed too (ticket 054). Only
 * SearXNG is configured here: the argument is dropped before the call and
 * WEB_SEARCH_PROVIDER decides.
 */
export function pinWebSearchProvider(pi: Pick<ExtensionAPI, "on">) {
	pi.on("tool_call", (event) => {
		if (event.toolName === "web_search" && event.input && "provider" in event.input) {
			delete (event.input as Record<string, unknown>).provider;
		}
	});
}

/** Where rpiv-web-tools reads its file: $XDG_CONFIG_HOME if absolute, else ~/.config. */
function webToolsConfigPath(env = process.env): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const root = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
	return join(root, "rpiv-web-tools", "config.json");
}

/**
 * Settings the packages read from files: pi-vcc's goes in Pi's agent dir
 * (PI_VCC_CONFIG_PATH, not ~/.pi/agent), rpiv-web-tools' where it looks for
 * it (it has no variable for the path); both rewritten on every start like
 * settings.json.
 */
export function configurePackages(agentDir: string, env = process.env) {
	if (enabledPackages(env).some((p) => p.flag === "NERD_WEB")) {
		const web = webToolsConfigPath(env);
		mkdirSync(dirname(web), { recursive: true });
		writeFileSync(web, JSON.stringify(webToolsConfig(), null, "\t"));
	}
	const path = join(agentDir, "pi-vcc-config.json");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_VCC_CONFIG_PATH = path;
	writeFileSync(
		path,
		JSON.stringify(
			{
				// Every compaction (threshold and overflow), not only /pi-vcc.
				overrideDefaultCompaction: true,
				smartKeepTail: true,
				// Pi 1.0 resumes the run after a compaction itself.
				continueAfterThresholdCompact: false,
				debug: env.NERD_PI_VCC_DEBUG === "1",
				skipForProviders: [],
				skipCustomTypes: [],
			},
			null,
			"\t",
		),
	);
}
