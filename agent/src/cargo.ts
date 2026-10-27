// Rust projects in the harness (process ticket 090, stage 2). The stage-1 probe ran
// Bonsai on six small Rust tasks with no harness at all — 17 of 18 passed, the model ran
// `cargo test` itself every time — while the done gate, the Done when checks and the
// linters knew only npm, node and biome. Here is what they share for a Cargo project:
//   - one target dir per project in the cache, linked as target/ into the clean clones of the
//     gate and of the checks, so they do not each build everything from nothing;
//   - the errors of rustc/clippy in --message-format=short: "file:line:col: error…".
// No imports from the gate (done-gate.ts uses these).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function isCargoProject(dir: string): boolean {
	return existsSync(join(dir, "Cargo.toml"));
}

/** The Cargo.toml directory nearest above `file` (inclusive), or undefined. */
export function crateRoot(file: string, stop = "/"): string | undefined {
	for (let d = dirname(resolve(file)); ; d = dirname(d)) {
		if (isCargoProject(d)) return d;
		if (d === stop || dirname(d) === d) return undefined;
	}
}

/** The shared target directory of the project at `root` (the agent's repository, not a clone). */
export function cargoTargetDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
	const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cache, "nerd", "cargo-target", createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16));
}

/**
 * Cargo's environment in `app`, a clean clone of the project at `root`: its `target` is a link to
 * the project's shared target dir (made here when the clone has none), so the build is shared and
 * `./target/debug/<bin>` is where a check expects it. Not CARGO_TARGET_DIR: with it the clone has
 * no target/ at all, and a check that runs `target/debug/stats` exits 127 (process ticket 093:
 * two Ralph rounds of rs-stats-2 lost to that). No colours or progress bars.
 */
export function cargoEnv(app: string, root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const link = join(app, "target");
	if (!existsSync(link)) {
		const shared = cargoTargetDir(root, base);
		mkdirSync(shared, { recursive: true });
		try {
			symlinkSync(shared, link, "dir");
		} catch {}
	}
	const { CARGO_TARGET_DIR: _, ...env } = base;
	return { ...env, CARGO_TERM_COLOR: "never", CARGO_TERM_PROGRESS_WHEN: "never" };
}

export function haveCargo(env: NodeJS.ProcessEnv = process.env): boolean {
	return spawnSync("cargo", ["--version"], { env, encoding: "utf8", timeout: 20_000 }).status === 0;
}

export function haveClippy(env: NodeJS.ProcessEnv = process.env): boolean {
	return spawnSync("cargo", ["clippy", "--version"], { env, encoding: "utf8", timeout: 20_000 }).status === 0;
}

// cargo's own summary lines after the real errors; they say nothing new.
const SUMMARY = /^error: (could not compile|aborting due to|process didn't exit successfully|\d+ previous errors?|test failed|build failed)/;

/** The error lines of rustc/clippy output in --message-format=short, distinct, in order. */
export function cargoErrors(out: string): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const raw of out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
		const l = raw.trim();
		if (!/(^|: )error(\[[A-Z]?\d+\])?: /.test(l) || SUMMARY.test(l)) continue;
		if (!seen.has(l)) {
			seen.add(l);
			lines.push(l);
		}
	}
	return lines;
}
