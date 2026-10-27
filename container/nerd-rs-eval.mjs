#!/usr/bin/env node
// nerd-rs-eval: run a few Rust statements against the library crate of the project here, as
// `node -e` runs JS against a module (process ticket 090). A Done when check of a Rust library
// needs a command that calls the code on a concrete input; `cargo test` runs tests the work may
// write itself, so it does not count. This builds a one-file binary crate with the project as a
// path dependency (its items in scope: `use <lib>::*`) and runs it: the exit code is the
// program's — a failed assert! panics, exit 101 — and a compile error fails too.
//
//   nerd-rs-eval [-C <dir>] '<statements>'
//   nerd-rs-eval 'assert_eq!(to_roman(4), "IV");'
//
// The scratch crate lives in the project's target dir ($CARGO_TARGET_DIR, else its target/,
// else the cache dir the harness uses, agent/src/cargo.ts), one per program text, built once.
// Exit 2: no Cargo.toml, no library target, or no program given.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const die = (msg) => {
	console.error(`nerd-rs-eval: ${msg}`);
	process.exit(2);
};
const args = process.argv.slice(2);
let dir = process.cwd();
if (args[0] === "-C") {
	dir = resolve(args[1] ?? die("-C needs a directory"));
	args.splice(0, 2);
}
if (args.length !== 1 || !args[0].trim()) die("give the Rust statements as one argument, in single quotes: nerd-rs-eval 'assert_eq!(f(1), 2);'");
const code = args[0];
const manifest = join(dir, "Cargo.toml");
if (!existsSync(manifest)) die(`no Cargo.toml in ${dir}`);

const meta = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 64 << 20 });
if (meta.status !== 0) {
	process.stderr.write(meta.stderr);
	die("cargo metadata failed");
}
const pkg = JSON.parse(meta.stdout).packages.find((p) => resolve(p.manifest_path) === resolve(manifest));
if (!pkg) die(`${manifest} is a workspace without a package of its own`);
const lib = pkg.targets.find((t) => t.kind.some((k) => ["lib", "rlib", "proc-macro"].includes(k)));
if (!lib) die(`package ${pkg.name} has no library target (src/lib.rs): for a binary, check it with \`cargo run -q -- <args>\``);
const libName = lib.name.replace(/-/g, "_");

const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
// The project's own target/ when it has one (in the harness's clean clone a link to the shared
// dir, agent/src/cargo.ts), else the shared dir by the project's path.
const own = join(dir, "target");
const target =
	process.env.CARGO_TARGET_DIR ||
	(existsSync(own) ? realpathSync(own) : join(cache, "nerd", "cargo-target", createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16)));
// By package and program, not by path: the harness runs a check in a new clean clone each time,
// and the same check should reuse its scratch crate and binary in the shared target dir.
const id = createHash("sha256").update(`${pkg.name}\0${code}`).digest("hex").slice(0, 16);
const crate = join(target, "nerd-rs-eval", id);
mkdirSync(join(crate, "src"), { recursive: true });
// Its own package name: one shared name gave one binary path in the target dir, and cargo ran
// the first program's binary for every other one.
const toml = `[package]
name = "nerd_rs_eval_${id}"
version = "0.0.0"
edition = "${pkg.edition || "2021"}"
publish = false

[dependencies]
${JSON.stringify(pkg.name)} = { path = ${JSON.stringify(resolve(dir))} }

[workspace]
`;
writeFileSync(join(crate, "Cargo.toml"), toml);
writeFileSync(
	join(crate, "src", "main.rs"),
	`#![allow(unused_imports, unused_variables, unused_mut, dead_code, unused_must_use)]\n#[allow(unused_imports)]\nuse ${libName}::*;\n\nfn main() {\n${code}\n}\n`,
);
const run = spawnSync("cargo", ["run", "-q", "--manifest-path", join(crate, "Cargo.toml")], {
	stdio: "inherit",
	env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR || "never" },
});
process.exit(run.status ?? 1);
