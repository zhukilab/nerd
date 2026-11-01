// /nerd in Pi's TUI (process ticket 097; Pi's own /settings is its interface settings): the agent's settings from the registry, grouped, each with
// its value and where that comes from; Enter picks a new value, which goes into the settings file
// (settings.ts) and into this process at once. What a change needs before it acts (the registry's
// `apply`) is done or said on closing: a reload of the extensions is offered, a Pi or container
// restart is named. The host's and the model server's settings are ./SETTINGS's (on the host).
//
//   /nerd        what an operator usually changes
//   /nerd all    and the tuning knobs

import { type ExtensionAPI, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import { readLines, setLive, settingsFile, writeSetting } from "./settings.ts";
import { type Setting, SETTINGS } from "./settings-registry.ts";
import { settingItems, short, shown, strongest } from "./settings-view.ts";

export function agentSettings(all: boolean): Setting[] {
	return SETTINGS.filter((s) => s.owner === "agent" && s.level !== "internal" && (all || s.level === "user")).sort(
		(a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
	);
}

export function fileMap(path: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const l of readLines(path)) if (l.name !== undefined && l.value !== undefined) m.set(l.name, l.value);
	return m;
}

export function settingsCommand(pi: ExtensionAPI) {
	pi.registerCommand("nerd", {
		description: "The agent's settings: see and change them (/nerd all: with the tuning knobs)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`/nerd needs the TUI; edit ${settingsFile()} instead`, "error");
				return;
			}
			const path = settingsFile();
			const changed = new Map<string, Setting>();

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const file = fileMap(path);
				const pick = (s: Setting, value: string | undefined) => {
					writeSetting(path, s.name, value);
					setLive(s.name, value);
					if (value === undefined) file.delete(s.name);
					else file.set(s.name, value);
					changed.set(s.name, s);
					if (s.name === "NERD_THINKING") pi.setThinkingLevel((process.env.NERD_THINKING || s.default) as never);
					return shown(s, process.env, file);
				};
				const items = settingItems(
					agentSettings(args.trim() === "all"),
					(s) => `${s.group}: ${short(s.name)}`,
					(s) => shown(s, process.env, file),
					(s) => file.get(s.name) ?? "",
					pick,
					(m) => ctx.ui.notify(m, "error"),
				);
				const box = new Container();
				box.addChild(new Text(theme.fg("accent", theme.bold(`nerd settings  ${path}`)), 0, 0));
				box.addChild(new Text(theme.fg("dim", "Enter: change · Esc: close · type to search · the host's and the model server's: ./SETTINGS"), 0, 0));
				const list = new SettingsList(items, Math.min(items.length + 2, 18), getSettingsListTheme(), () => {}, () => done(), { enableSearch: true });
				box.addChild(list);
				return {
					render: (w: number) => box.render(w),
					invalidate: () => box.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			});

			const need = strongest(changed.values());
			const names = [...changed.keys()].map(short).join(", ");
			if (need === undefined) return;
			if (need === "turn") ctx.ui.notify(`${names}: acts from the next request`, "info");
			else if (need === "reload") {
				if (await ctx.ui.confirm("Reload the extensions?", `${names} act after a reload of the extensions (the conversation stays).`)) await ctx.reload();
				else ctx.ui.notify(`${names}: saved; /reload applies them`, "info");
			} else if (need === "restart")
				ctx.ui.notify(`${names}: saved; they act when Pi restarts (/quit: in the container Pi starts again and continues the conversation)`, "warning");
			else ctx.ui.notify(`${names}: saved; they act when the container restarts (./SETTINGS on the host offers it)`, "warning");
		},
	});
}
