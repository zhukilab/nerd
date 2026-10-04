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
// rpiv-todo (a task list tool) was measured and left out: +520 tokens in
// every request, statuses kept, but the model never read the list back after
// a compaction; the plan step's PLAN.md does that job.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PiPackage {
	flag: string;
	name: string;
	/** Tools it registers: the harness must keep them active. */
	tools: string[];
	on: boolean;
}

export const PI_PACKAGES: PiPackage[] = [{ flag: "NERD_PI_VCC", name: "@sting8k/pi-vcc", tools: ["vcc_recall"], on: true }];

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

/**
 * Settings the packages read from files: pi-vcc's goes in Pi's agent dir
 * (PI_VCC_CONFIG_PATH, not ~/.pi/agent), rewritten on every start like
 * settings.json.
 */
export function configurePackages(agentDir: string, env = process.env) {
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
