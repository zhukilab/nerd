// Rust in the harness (process ticket 090): cargo's error lines, and nerd-rs-eval — a Rust
// library's inline behaviour check (container/nerd-rs-eval.mjs) — where cargo is on PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cargoErrors, cargoTargetDir, crateRoot } from "../src/cargo.ts";
import { tempDir } from "./tmp.ts";

const EVAL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "container", "nerd-rs-eval.mjs");
const CARGO = spawnSync("sh", ["-c", "command -v cargo"]).status === 0 ? undefined : "cargo not on PATH";

test("cargo: error lines, cargo's own summaries left out", () => {
	const out = [
		"   Compiling demo v0.1.0 (/x)",
		"src/lib.rs:2:23: error[E0308]: mismatched types: expected `u32`, found `&str`",
		"src/lib.rs:1:31: error: equal expressions as operands to `==`",
		"warning: unused variable: `x`",
		"error: could not compile `demo` (lib) due to 1 previous error",
		"error: test failed, to rerun pass `--lib`",
		"src/lib.rs:2:23: error[E0308]: mismatched types: expected `u32`, found `&str`",
	].join("\n");
	assert.deepEqual(cargoErrors(out), [
		"src/lib.rs:2:23: error[E0308]: mismatched types: expected `u32`, found `&str`",
		"src/lib.rs:1:31: error: equal expressions as operands to `==`",
	]);
});

test("cargo: the crate root above a file; one target dir per project, in the cache", () => {
	const d = tempDir("nerd-cargo-root-");
	mkdirSync(join(d, "src", "a"), { recursive: true });
	writeFileSync(join(d, "Cargo.toml"), "[package]\n");
	assert.equal(crateRoot(join(d, "src", "a", "x.rs")), d);
	assert.equal(crateRoot("/no/such/file.rs"), undefined);
	assert.match(cargoTargetDir("/w", { XDG_CACHE_HOME: "/c" }), /^\/c\/nerd\/cargo-target\/[0-9a-f]{16}$/);
	assert.notEqual(cargoTargetDir("/w", {}), cargoTargetDir("/v", {}));
});

test("nerd-rs-eval: statements run with the crate in scope; a failed assert and a compile error fail; no lib is exit 2", { skip: CARGO }, () => {
	const d = tempDir("nerd-rs-eval-");
	const crate = join(d, "rom");
	mkdirSync(join(crate, "src"), { recursive: true });
	writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "rom"\nversion = "0.1.0"\nedition = "2021"\n');
	writeFileSync(join(crate, "src", "lib.rs"), 'pub fn to_roman(n: u32) -> String { if n == 4 { "IV".into() } else { "I".repeat(n as usize) } }\n');
	const env = { ...process.env, CARGO_TARGET_DIR: join(d, "target") };
	const run = (code: string, cwd = crate) => spawnSync("node", [EVAL, code], { cwd, env, encoding: "utf8", timeout: 300_000 });
	assert.equal(run('assert_eq!(to_roman(4), "IV");').status, 0);
	const printed = run('assert_eq!(rom::to_roman(3), "III"); println!("ok {}", to_roman(2));');
	assert.equal(printed.status, 0, printed.stderr);
	assert.equal(printed.stdout.trim(), "ok II");
	const wrong = run('assert_eq!(to_roman(5), "V");');
	assert.equal(wrong.status, 101);
	assert.match(wrong.stderr, /left: "IIIII"/);
	assert.notEqual(run('let x: u32 = "a";').status, 0);
	const bin = join(d, "b");
	mkdirSync(join(bin, "src"), { recursive: true });
	writeFileSync(join(bin, "Cargo.toml"), '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n');
	writeFileSync(join(bin, "src", "main.rs"), "fn main() {}\n");
	const nolib = run("x();", bin);
	assert.equal(nolib.status, 2);
	assert.match(nolib.stderr, /no library target.*cargo run -q -- <args>/);
	assert.equal(spawnSync("node", [EVAL], { cwd: crate, env, encoding: "utf8" }).status, 2);
});
