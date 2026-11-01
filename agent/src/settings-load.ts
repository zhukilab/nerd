// Imported first by tui.ts and run.ts, before any module that reads a NERD_* setting at load time:
// the operator's settings file into process.env (settings.ts).

import { applySettingsFile, settingsFile } from "./settings.ts";

for (const p of applySettingsFile()) {
	console.error(`[nerd] ${settingsFile()}: ${p.name}=${p.value} left out: ${p.why} (/nerd shows what is allowed)`);
}
