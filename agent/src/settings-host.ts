// ./SETTINGS's screen (process ticket 097), run from the agent's image with the repository and the
// agent's home volume mounted: every setting of the registry -- the host's and the model server's in
// .env, the agent's in its settings file -- with its value and where that comes from.
//
//   node settings-host.ts show --env <.env> --agent <agent's settings file> --out <file> [all]
//       The screen. .env is written at once (it is the host user's: run with their uid); the agent's
//       file usually is not writable from here, so its changes go to <file> for `apply`, with what
//       the changes need: lines "need host up", "need agent <apply>", "set NAME=VALUE", "unset NAME".
//   node settings-host.ts apply <file> --agent <agent's settings file>
//       The "set"/"unset" lines of <file> into the agent's file (run as the agent's user).

import { initTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, SettingsList, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { readLines, writeSetting } from "./settings.ts";
import { type Setting, SETTINGS } from "./settings-registry.ts";
import { settingItems, short, shown, strongest } from "./settings-view.ts";

function fileMap(path: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const l of readLines(path)) if (l.name !== undefined && l.value !== undefined) m.set(l.name, l.value);
	return m;
}

function flag(args: string[], name: string): string {
	const i = args.indexOf(name);
	if (i < 0 || !args[i + 1]) {
		console.error(`settings-host: ${name} <path> is required`);
		process.exit(2);
	}
	return args[i + 1];
}

const ownerOrder = { host: 0, server: 1, agent: 2 } as const;

function show(args: string[]): void {
	const envPath = flag(args, "--env");
	const agentPath = flag(args, "--agent");
	const out = flag(args, "--out");
	const all = args.includes("all");
	const list = SETTINGS.filter((s) => s.level !== "internal" && (all || s.level === "user")).sort(
		(a, b) => ownerOrder[a.owner] - ownerOrder[b.owner] || a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
	);
	const hostFile = fileMap(envPath);
	const agentFile = fileMap(agentPath);
	const fileOf = (s: Setting) => (s.owner === "agent" ? agentFile : hostFile);
	const changed = new Map<string, Setting>();
	const pending = new Map<string, string | undefined>();

	initTheme(undefined, false);
	const tui = new TuiMainScreen(new ProcessTerminal());
	const box = new Container();
	const message = new Text("", 0, 0);
	const finish = () => {
		tui.stop();
		const host = [...changed.values()].filter((s) => s.owner !== "agent");
		const agent = [...changed.values()].filter((s) => s.owner === "agent");
		const lines = [
			...(host.length ? ["need host up"] : []),
			...(agent.length ? [`need agent ${strongest(agent)}`] : []),
			...[...pending].map(([n, v]) => (v === undefined ? `unset ${n}` : `set ${n}=${v}`)),
		];
		writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
		process.exit(0);
	};
	const pick = (s: Setting, value: string | undefined) => {
		const file = fileOf(s);
		if (s.owner === "agent") pending.set(s.name, value);
		else writeSetting(envPath, s.name, value);
		if (value === undefined) file.delete(s.name);
		else file.set(s.name, value);
		changed.set(s.name, s);
		return shown(s, {}, file);
	};
	const items = settingItems(
		list,
		(s) => `${s.owner === "agent" ? "agent" : s.owner === "server" ? "model server" : "host"} · ${s.group}: ${short(s.name)}`,
		(s) => shown(s, {}, fileOf(s)),
		(s) => fileOf(s).get(s.name) ?? "",
		pick,
		(m) => {
			message.setText(m);
			tui.requestRender();
		},
	);
	box.addChild(new Text(`nerd settings${all ? " (all)" : ""}: the host's and the model server's in .env, the agent's in its own file`, 0, 0));
	box.addChild(new Text("Enter: change · Esc: close (then ./SETTINGS applies what changed) · type to search", 0, 0));
	const settings = new SettingsList(items, Math.max(8, (process.stdout.rows || 30) - 8), getSettingsListTheme(), () => {}, finish, { enableSearch: true });
	box.addChild(settings);
	box.addChild(message);
	tui.addChild(box);
	tui.setFocus(settings);
	tui.start();
}

function apply(args: string[]): void {
	const from = args[0];
	const agentPath = flag(args, "--agent");
	for (const l of readLines(from)) {
		const set = /^set ([A-Z0-9_]+)=(.*)$/.exec(l.text);
		const unset = /^unset ([A-Z0-9_]+)$/.exec(l.text);
		if (set) writeSetting(agentPath, set[1], set[2]);
		else if (unset) writeSetting(agentPath, unset[1], undefined);
	}
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "show") show(rest);
else if (mode === "apply") apply(rest);
else {
	console.error("usage: settings-host.ts show --env <.env> --agent <file> --out <file> [all] | apply <file> --agent <file>");
	process.exit(2);
}
