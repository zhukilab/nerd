// The headless Pi session of run.ts, apart from the CLI, so tests can drive it
// with a scripted model: our system prompt and tools, nothing discovered from
// disk (no extensions, skills, templates, AGENTS.md), the enabled Pi packages
// from node_modules (packages.ts), and the harness extension (harness.ts)
// bound as in Pi's print mode.

import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { nerdBashTool } from "./bash-tool.ts";
import { allTools } from "./harness.ts";
import { type settingsFor, systemPrompt, type Thinking } from "./local.ts";
import { configurePackages, packagePaths } from "./packages.ts";

export interface HeadlessOptions {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	modelRuntime: ModelRuntime;
	thinking: Thinking;
	settings: ReturnType<typeof settingsFor>;
	extensions: ExtensionFactory[];
	/** Where the session file goes; without it the session is in memory only. */
	sessionDir?: string;
	env?: NodeJS.ProcessEnv;
}

export async function headlessSession(o: HeadlessOptions) {
	const env = o.env ?? process.env;
	configurePackages(o.agentDir, env);
	const settingsManager = SettingsManager.inMemory(o.settings);
	const resourceLoader = new DefaultResourceLoader({
		cwd: o.cwd,
		agentDir: o.agentDir,
		settingsManager,
		extensionFactories: o.extensions.map((factory, i) => ({ name: `nerd-${i}`, factory })),
		// The enabled Pi packages (packages.ts), from node_modules; nothing discovered.
		additionalExtensionPaths: packagePaths(env),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: systemPrompt(allTools(env).includes("web_fetch")),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: o.cwd,
		agentDir: o.agentDir,
		model: o.model,
		thinkingLevel: o.thinking,
		modelRuntime: o.modelRuntime,
		resourceLoader,
		// The plan step's read-only tools must be registered to be switched on;
		// the harness starts every session with TOOLS active.
		tools: allTools(env),
		// Replaces the built-in bash by name: the same tool with a default timeout.
		customTools: [nerdBashTool(o.cwd)],
		// A session file is what pi-vcc's vcc_recall searches.
		sessionManager: o.sessionDir ? SessionManager.create(o.cwd, o.sessionDir) : SessionManager.inMemory(o.cwd),
		settingsManager,
	});
	await session.bindExtensions({
		mode: "print",
		onError: (err) => console.error(`Extension error (${err.extensionPath}): ${err.error}`),
	});
	return session;
}
