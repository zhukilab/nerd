// Pi packages from npm (ticket 040), pinned in package.json and loaded by
// Pi's own extension loader (jiti: their sources import extensionless paths
// that plain Node does not resolve) from this agent's node_modules, never
// fetched at run time. Each one is switched by an environment variable.
//
//   NERD_PI_VCC=1|0  @sting8k/pi-vcc (on by default): compaction without a
//                    model call. The summary is extracted, not written: goal,
//                    files, commits, open items, a brief transcript; it is
//                    bounded and cannot fail on a token cap. In the A/B of
//                    ticket 040 (four hours, 64K, the same long task): Pi's
//                    own compaction took 46 of 229 minutes, each one 2 to 12
//                    minutes and growing with its summary; pi-vcc's took no
//                    measurable time. Its tool vcc_recall (search the session
//                    file for what compaction dropped) is left out of the
//                    active tools: the model never called it while working —
//                    0 calls in 60 A/B runs and three 0006 runs, 134
//                    compactions — and its schema cost ~486 tokens in every
//                    request (process tickets 049, 061). The anchors after a
//                    compaction (anchors.ts) bring back what matters instead.
//                    NERD_VCC_RECALL=1 offers it again.
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
	{ flag: "NERD_PI_VCC", name: "@sting8k/pi-vcc", tools: [], on: true },
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
	const tools = enabledPackages(env).flatMap((p) => p.tools);
	// pi-vcc registers vcc_recall either way; it is offered only when asked for.
	const vcc = enabledPackages(env).some((p) => p.flag === "NERD_PI_VCC");
	return vcc && env.NERD_VCC_RECALL === "1" ? [...tools, "vcc_recall"] : tools;
}

export function packageReadOnlyTools(env = process.env): string[] {
	return enabledPackages(env).flatMap((p) => p.readOnly ?? []);
}

/**
 * rpiv-web-tools' settings. Provider and URL come from the environment
 * (WEB_SEARCH_PROVIDER, SEARXNG_URL; the entrypoint sets both). The file used
 * to carry guidance lines for the model (promptSnippet, promptGuidelines), but
 * Pi drops tools' guidance whenever a system prompt of our own is set, so none
 * of it ever reached the model (prompt audit, ticket 059): what matters of it
 * is now in local.ts (WEB_PROMPT) and web-notes.ts.
 */
export function webToolsConfig() {
	return { provider: "searxng" };
}

/** A tool declaration in a provider request: OpenAI's {function: {name, parameters}} or a flat {name, parameters}. */
type ToolDecl = { name?: string; parameters?: { properties?: Record<string, unknown>; required?: string[] }; function?: ToolDecl };

function withoutProvider(f: ToolDecl): ToolDecl {
	const { provider: _, ...properties } = f.parameters?.properties ?? {};
	const required = f.parameters?.required?.filter((r) => r !== "provider");
	return { ...f, parameters: { ...f.parameters, properties, ...(required ? { required } : {}) } };
}

/**
 * A request's payload without web_search's `provider` parameter, or undefined
 * when there is none to drop. Copies, never edits: the declaration objects may
 * be the tool's own schema, which Pi also validates calls against.
 */
export function stripProviderParam(payload: unknown): unknown {
	const tools = (payload as { tools?: ToolDecl[] } | null)?.tools;
	if (!Array.isArray(tools)) return undefined;
	let dropped = false;
	const out = tools.map((t) => {
		const f = t.function ?? t;
		if (f.name !== "web_search" || !f.parameters?.properties || !("provider" in f.parameters.properties)) return t;
		dropped = true;
		return t.function ? { ...t, function: withoutProvider(f) } : withoutProvider(f);
	});
	return dropped ? { ...(payload as object), tools: out } : undefined;
}

/**
 * web_search takes an optional `provider` argument, and the model fills it in:
 * in the A/B of ticket 048, after a SearXNG error it tried brave, tavily,
 * perplexity — all without keys, so they failed too (ticket 054). Only
 * SearXNG is configured here: the argument is dropped before the call and
 * WEB_SEARCH_PROVIDER decides. Its declaration (~100 tokens listing every
 * provider and the /web-tools command) is cut from each request too, so the
 * model is not offered it (ticket 059).
 */
export function pinWebSearchProvider(pi: Pick<ExtensionAPI, "on">) {
	pi.on("tool_call", (event) => {
		if (event.toolName === "web_search" && event.input && "provider" in event.input) {
			delete (event.input as Record<string, unknown>).provider;
		}
	});
	pi.on("before_provider_request", (event) => stripProviderParam(event.payload));
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
