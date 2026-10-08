// Pi's own interactive TUI against the local llama-server, with nerd's setup
// as an inline extension (extension.ts). The container's `tui` mode runs this
// inside tmux; the operator attaches over ssh (container/entrypoint.sh).
//
//   node src/tui.ts <workspace-dir> [pi options...]
//
// Environment: the NERD_* variables of run.ts (NERD_BASE_URL, NERD_CTX,
// NERD_THINKING, NERD_VERIFY_N, NERD_SPEC_CHECK_ROUNDS, NERD_PLAN_STEP,
// NERD_LOOP_GUARD_N, NERD_PI_VCC; NERD_PLAN_ANSWER is unused here: the operator answers) plus
//   PI_CODING_AGENT_DIR  Pi's settings and state (default ~/.pi/nerd); its
//                        settings.json is rewritten on every start
//   NERD_SESSION_DIR     where sessions are stored (default: Pi's, in the agent dir)
//   NERD_VERIFY_LOG      the verifier's JSONL log, when NERD_VERIFY_N > 1
// Extra options go to Pi as they are, e.g. --continue to pick up the last session.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import nerd from "./extension.ts";
import { allTools } from "./harness.ts";
import { localModel, operatorPrompt, settingsFor, stayOffline, systemPrompt } from "./local.ts";
import { configurePackages, packagePaths } from "./packages.ts";

stayOffline();

const [workspace, ...rest] = process.argv.slice(2);
if (!workspace) {
	console.error("usage: node src/tui.ts <workspace-dir> [pi options...]");
	process.exit(2);
}
const cwd = resolve(workspace);
mkdirSync(cwd, { recursive: true });
process.chdir(cwd);

const local = await localModel();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "nerd");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
configurePackages(agentDir);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify(
		{
			...settingsFor(local),
			defaultProvider: "local",
			defaultModel: local.id,
			defaultThinkingLevel: local.thinking,
			// Only our model: the hidden built-in llama.cpp provider stays out of /model.
			enabledModels: [`local/${local.id}`],
			quietStartup: true,
			collapseChangelog: true,
			// Pi 1.0 runs fullscreen by default; regular keeps tmux's scrollback,
			// which the operator and the TUI drivers (capture-pane) read.
			tuiMode: "regular",
		},
		null,
		"\t",
	),
);

const args = [
	"--model", `local/${local.id}`,
	"--thinking", local.thinking,
	// Registered: the work's tools and the plan step's read-only ones; the
	// harness keeps only the work's tools active outside the plan step.
	"--tools", allTools().join(","),
	"--system-prompt", systemPrompt(allTools().includes("web_fetch")),
	"--append-system-prompt", operatorPrompt(),
	// As in the headless run: no discovered extensions, skills, templates or
	// AGENTS.md files, and nothing project-local from the workspace.
	"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
	"--offline",
	// The enabled Pi packages (packages.ts), from node_modules: -e loads them
	// although --no-extensions turns off discovery.
	...packagePaths().flatMap((p) => ["-e", p]),
	...(process.env.NERD_SESSION_DIR ? ["--session-dir", process.env.NERD_SESSION_DIR] : []),
	...rest,
];
await main(args, { extensionFactories: [{ name: "nerd", factory: nerd }] });
