// Patches to third-party packages in node_modules, applied after `npm ci` (package.json
// "postinstall"). Each patch names one file and the sha256 it must have as the pinned version
// ships it, and replaces one exact piece of text. Already patched (its marker present): left
// as it is. Any other content — a new version, an edit by hand — fails the install, so a
// version bump makes someone look at the patch again instead of losing it silently.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import piVcc from "./pi-vcc.mjs";

const agent = join(import.meta.dirname, "..");
let failed = false;
for (const p of [piVcc]) {
	const path = join(agent, p.file);
	const text = readFileSync(path, "utf8");
	if (text.includes(p.marker)) {
		console.log(`patches: ${p.file}: already patched`);
		continue;
	}
	const sha = createHash("sha256").update(text).digest("hex");
	if (sha !== p.sha256 || text.split(p.old).length !== 2) {
		console.error(`patches: ${p.file}: not the file the patch was made for (sha256 ${sha}); look at agent/patches/ again`);
		failed = true;
		continue;
	}
	writeFileSync(path, text.replace(p.old, p.new));
	console.log(`patches: ${p.file}: patched`);
}
if (failed) process.exit(1);
