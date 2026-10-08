// Temp dirs of a test file (ticket 053 of the process): made under $TMPDIR,
// all removed after the file's tests; one that could not be removed is
// printed, so nothing is left behind silently.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made: string[] = [];

after(() => {
	for (const d of made) {
		rmSync(d, { recursive: true, force: true });
		if (existsSync(d)) console.error(`[tmp] left behind: ${d}`);
	}
});

export function tempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
