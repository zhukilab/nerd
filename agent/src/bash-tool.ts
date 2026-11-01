// Pi's bash tool with a default timeout. Pi's own has none: a server started
// in the foreground (python3 -m http.server) never returns, and the agent waits
// for it indefinitely (2 of 8 runs in the operator-prompt A/B of 2026-10-03).
// Here a call without a timeout gets NERD_BASH_TIMEOUT seconds (600), and a
// timed-out call tells the model what happened and what to do instead.
//
// The tool replaces the built-in "bash" by name: as an extension tool in the
// TUI (extension.ts), as a custom tool in the headless run (run.ts). On a
// timeout Pi kills the command's whole process group, so whatever was started
// in it without setsid/nohup goes too.
//
// With tmux (NERD_RUNS, default on) each command runs in a window of tmux
// session nerd-runs (tmux-runs.ts): the same result, and a person can watch it.

import { createBashToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { outputMax } from "./output-cap.ts";
import { RUNS_SESSION, RUNS_TOOL, runsOfProcess, runsToolOn, tmuxOperations, tmuxRunsOn } from "./tmux-runs.ts";

/**
 * 600 s: long enough for the slow legitimate commands of a small project (a
 * cold `npm ci` or a test suite takes minutes), short enough that a hung call
 * costs one step of an 8-hour run rather than the run. The model can still
 * give a longer timeout explicitly.
 */
export const DEFAULT_BASH_TIMEOUT = 600;

export function bashTimeout(env = process.env): number {
	const v = Number(env.NERD_BASH_TIMEOUT);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_BASH_TIMEOUT;
}

export function timeoutMessage(secs: number, env = process.env): string {
	const start = runsToolOn(env)
		? `start it with the ${RUNS_TOOL} tool (action start), then check it in a separate command (curl) and read its output with ${RUNS_TOOL} output. `
		: "start it detached with its output to a file, e.g. `setsid nohup python3 -m http.server 8000 > server.log 2>&1 < /dev/null &`, " +
			"then check it in a separate command (curl, tail server.log). ";
	return (
		`The command did not return within ${secs} s and was killed together with everything it started in the foreground. ` +
		`A long-running process (a web server, a watcher) must not run in the foreground of a bash call: ${start}` +
		"A client script (a WebSocket or HTTP test client) " +
		"must close its connection and exit, with a timeout of its own. If the command is just slow, give it a larger timeout."
	);
}

/** Exit code 130 from a window: Ctrl-C, most likely a person watching it. */
export const INTERRUPT_NOTE = `(Exit code 130: interrupted with Ctrl-C, likely by a person watching it in tmux session ${RUNS_SESSION}.)`;

/**
 * Quiet defaults for the model's commands (ticket 057 of the process): no
 * colour codes, no progress bars, no npm fund/audit/update notices, no pager.
 * Every line of that is context the model pays for and learns nothing from. Only
 * the commands of the bash tool get them, not Pi's own screen; a variable the
 * environment already sets wins. NERD_QUIET=0 turns them off.
 */
export const QUIET_ENV: Record<string, string> = {
	NO_COLOR: "1",
	FORCE_COLOR: "0",
	NPM_CONFIG_FUND: "false",
	NPM_CONFIG_AUDIT: "false",
	NPM_CONFIG_UPDATE_NOTIFIER: "false",
	NPM_CONFIG_PROGRESS: "false",
	NPM_CONFIG_LOGLEVEL: "error",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	PIP_PROGRESS_BAR: "off",
	UV_NO_PROGRESS: "1",
	CARGO_TERM_PROGRESS_WHEN: "never",
	CARGO_TERM_COLOR: "never",
	GIT_PAGER: "cat",
	PAGER: "cat",
};

export function quietEnv(base: NodeJS.ProcessEnv, env = process.env): NodeJS.ProcessEnv {
	return env.NERD_QUIET === "0" ? base : { ...QUIET_ENV, ...base };
}

/**
 * Pi's description with what this tool really does: our default timeout, and
 * the cut of long output by output-cap.ts (head and tail, not Pi's last 2000
 * lines or 50KB) when NERD_BASH_MAX_CHARS is on (prompt audit, ticket 059).
 */
export function bashDescription(piText: string, defaultSecs: number, env = process.env): string {
	const max = outputMax(env);
	let d = piText.replace(
		"Optionally provide a timeout in seconds.",
		`Commands time out after ${defaultSecs} s unless you give another timeout in seconds; ` +
			(runsToolOn(env) ? `start servers with the ${RUNS_TOOL} tool.` : "start servers detached."),
	);
	if (max > 0) {
		d = d.replace(
			/Output is truncated to last .*? \(whichever is hit first\)\. If truncated, full output is saved to a temp file\./,
			`Output over ${max} characters is cut to its first and last lines (errors usually come last); the whole output is saved to a file named in the result.`,
		);
	}
	return d;
}

/** The built-in bash tool for `cwd` with a default timeout of `defaultSecs`. */
export function nerdBashTool(cwd: string, defaultSecs = bashTimeout()) {
	const windows = tmuxRunsOn();
	const base = createBashToolDefinition(cwd, {
		spawnHook: (c) => ({ ...c, env: quietEnv(c.env) }),
		...(windows ? { operations: tmuxOperations(runsOfProcess()) } : {}),
	});
	// Pi's schema says "no default timeout"; the same schema with our default
	// in the description (spread keeps TypeBox's symbol keys).
	const p = base.parameters;
	const parameters = {
		...p,
		properties: {
			...p.properties,
			timeout: { ...p.properties.timeout, description: `Timeout in seconds (default ${defaultSecs})` },
		},
	} as typeof p;
	// defineTool: usable both by registerTool and in customTools' array.
	return defineTool({
		...base,
		description: bashDescription(base.description, defaultSecs),
		parameters,
		async execute(id, params, signal, onUpdate, ctx) {
			const timeout = params.timeout ?? defaultSecs;
			try {
				const r = await base.execute(id, { ...params, timeout }, signal, onUpdate, ctx);
				const last = r.content.at(-1);
				if (windows && last?.type === "text" && /Command exited with code 130$/.test(last.text)) {
					return { ...r, content: [...r.content.slice(0, -1), { ...last, text: `${last.text}\n${INTERRUPT_NOTE}` }] };
				}
				return r;
			} catch (e) {
				// Pi ends a timed-out call with "<output>\n\nCommand timed out after N seconds".
				if (e instanceof Error && /Command timed out after \S+ seconds$/.test(e.message)) {
					const output = e.message.replace(/\n*Command timed out after \S+ seconds$/, "");
					throw new Error(`${output ? `${output}\n\n` : ""}${timeoutMessage(timeout)}`);
				}
				throw e;
			}
		},
	});
}
