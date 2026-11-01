// The list of settings as /nerd (in Pi) and ./SETTINGS (on the host) show it: one row per setting
// with its value and where that comes from, Enter opens a picker (a choice, or a line to type).
// What a pick does is the caller's (`pick` returns the row's new value text).

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Input, type SettingItem, SelectList } from "@earendil-works/pi-tui";
import type { Apply, Setting } from "./settings-registry.ts";

export const short = (name: string) => name.replace(/^NERD_/, "");

/** The value shown: the file's as it is, otherwise marked as the environment's or the default. */
export function shown(s: Setting, env: Record<string, string | undefined>, file: Map<string, string>): string {
	if (file.has(s.name)) return file.get(s.name) || "(unset)";
	const v = env[s.name];
	if (v !== undefined && v !== "") return `${v}  (environment)`;
	return `${s.default || "auto"}  (default)`;
}

export function needs(a: Apply): string {
	return { turn: "acts at once", reload: "acts after a reload", restart: "needs a Pi restart", up: "needs ./UP" }[a];
}

const order: Apply[] = ["turn", "reload", "restart", "up"];

/** The strongest need among the changed settings. */
export function strongest(changed: Iterable<Setting>): Apply | undefined {
	let top = -1;
	for (const s of changed) top = Math.max(top, order.indexOf(s.apply));
	return top < 0 ? undefined : order[top];
}

const DEFAULT = "\0default";

/**
 * Rows for a SettingsList. `pick(s, value)` stores a value (undefined: back to the default) and returns
 * the row's new text; `complain` reports a typed value that does not fit.
 */
export function settingItems(
	list: Setting[],
	label: (s: Setting) => string,
	current: (s: Setting) => string,
	typed: (s: Setting) => string,
	pick: (s: Setting, value: string | undefined) => string,
	complain: (message: string) => void,
): SettingItem[] {
	return list.map((s) => ({
		id: s.name,
		label: label(s),
		description: `${s.summary} [${s.name}; ${needs(s.apply)}]`,
		currentValue: current(s),
		submenu: (_current, close) => {
			if (s.kind.type === "bool" || s.kind.type === "choice") {
				const values = s.kind.type === "bool" ? ["1", "0"] : s.kind.choices;
				const picker = new SelectList(
					[
						{ value: DEFAULT, label: `default (${s.default || "auto"})`, description: "take the line out of the file" },
						...values.map((v) => ({ value: v, label: v })),
					],
					Math.min(values.length + 1, 10),
					getSelectListTheme(),
				);
				picker.onSelect = (item) => close(pick(s, item.value === DEFAULT ? undefined : item.value));
				picker.onCancel = () => close();
				return picker;
			}
			const input = new Input({ prompt: `${short(s.name)} = `, placeholder: `empty: default (${s.default || "auto"})` });
			input.setValue(typed(s));
			input.onSubmit = (v) => {
				const value = v.trim();
				if (s.kind.type === "int" && value !== "" && !/^-?\d+$/.test(value)) {
					complain(`${s.name}: a whole number`);
					return;
				}
				close(pick(s, value === "" ? undefined : value));
			};
			input.onEscape = () => close();
			return input;
		},
	}));
}
