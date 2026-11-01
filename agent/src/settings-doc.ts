// docs/SETTINGS.md from the settings registry (process ticket 097): every setting an operator may set,
// by owner and group. A test keeps the file and the registry in step.
//   node agent/src/settings-doc.ts > docs/SETTINGS.md

import { type Setting, SETTINGS } from "./settings-registry.ts";
import { needs } from "./settings-view.ts";

const owners = [
	["host", "The host: `.env`", "Read by `./UP`, `./DOWN`, `./STATUS` and the tools from `.env` (format in `env.example`). A change acts when `./UP` recreates the containers."],
	["server", "The model server", "Read in the model server's container (`container/model.sh`). `compose.yaml` does not pass these through: set them in `compose.override.yaml` (docs/OPERATE.md), or in `.env` with `NERD_LLAMA=host`."],
	["agent", "The agent", "Read by the agent (Pi). Set them with `/nerd` in Pi or `./SETTINGS` on the host; they are kept in `~/.config/nerd/settings.env` in the agent's home volume, which wins over the container's environment."],
] as const;

function values(s: Setting): string {
	const k = s.kind;
	if (k.type === "bool") return "1 / 0";
	if (k.type === "choice") return k.choices.join(" / ");
	if (k.type === "int") return k.min !== undefined && k.max !== undefined ? `${k.min}–${k.max}` : k.min !== undefined ? `≥ ${k.min}` : "number";
	return "text";
}

const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function settingsDoc(): string {
	const out = [
		"# Settings",
		"",
		"<!-- Generated from agent/src/settings-registry.ts by agent/src/settings-doc.ts; do not edit by hand. -->",
		"",
		"Every setting of nerd. `./SETTINGS` on the host shows and changes all of them (with `all`: the tuning",
		"knobs too); `/nerd` in Pi the agent's. Settings set by `./UP` or an entrypoint for the process it starts",
		"are not listed. **Default** \"\" means worked out, as the description says.",
		"",
	];
	for (const [owner, title, intro] of owners) {
		out.push(`## ${title}`, "", intro, "");
		const list = SETTINGS.filter((s) => s.owner === owner && s.level !== "internal");
		const groups = [...new Set(list.map((s) => s.group))];
		for (const g of groups) {
			out.push(`### ${g}`, "", "| Setting | Default | Values | Change | What it does |", "|---|---|---|---|---|");
			for (const s of list.filter((x) => x.group === g)) {
				const name = `\`${s.name}\`${s.level === "advanced" ? " (advanced)" : ""}${s.alias ? `, older \`${s.alias}\`` : ""}`;
				out.push(`| ${name} | ${s.default ? `\`${cell(s.default)}\`` : '""'} | ${values(s)} | ${needs(s.apply)} | ${cell(s.summary)} |`);
			}
			out.push("");
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}

if (import.meta.main) process.stdout.write(settingsDoc());
