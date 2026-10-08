// The done gate (process ticket 051). Three acceptance runs in a row (036, 047,
// and 0006 on main) ended with "done" on a project nobody could run or check:
// package.json kept `npm init`'s failing "test" stub, there was no start
// script and no README, so the operator's checker could not even start the
// server. The model was told, in the prompt, how its work would be checked; it
// did not act on it. So the harness checks, not the model.
//
// When a turn of work settles (the agent wrote or edited files, or its bash
// calls changed the repository), the harness checks the committed project the
// way the operator's checker will (acceptance/check.sh): a clean clone of HEAD,
// so uncommitted work counts as missing.
//   1. uncommitted changes: listed, to be committed
//   2. package.json: scripts.test exists, is not the npm init stub, and
//      `npm test` passes after `npm ci` / `npm install`
//   3. a start command: scripts.start, or exactly one node/npm command in a
//      README run/start section (acceptance/lib/parse.mjs, the checker's rule)
//   4. started with PORT=<free port>, it answers HTTP on / (HTML when the
//      project has .html files); a command that exits 0 without listening is a
//      CLI, not a server, and passes
//   The test and the start command run with gate-guard.cjs preloaded: loopback
//   ports that were listening before the check (the agent's own server) refuse
//   connections, as on the operator's empty machine.
//   5. the node/npm commands of a README "Check"/"Проверка" section pass in
//      the clean clone too (readmeChecks; none is not a failure)
//   6. no linter errors (lint-check.ts) in the files changed since the
//      operator's message
// Anything failing goes back to the model as one message listing what to fix,
// and the turn continues; at most NERD_DONE_GATE_ROUNDS (2) times per operator
// message, then the turn ends as it would have. A passing check adds nothing:
// no tokens. Not a git repository: no check. NERD_DONE_GATE=0 turns it off.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readmeCommands, startCommand } from "../../acceptance/lib/parse.mjs";
import { lintFile } from "./lint-check.ts";

export function doneGateOn(env = process.env): boolean {
	return env.NERD_DONE_GATE !== "0";
}

export function doneGateRounds(env = process.env): number {
	const n = Number(env.NERD_DONE_GATE_ROUNDS ?? 2);
	return Number.isFinite(n) && n >= 0 ? n : 2;
}

const INSTALL_MS = 300_000;
const TEST_MS = 300_000;
const SERVE_MS = 20_000;
const TAIL_LINES = 15;
const NPM_INIT_STUB = /no test specified/;

type Run = { code: number | null; out: string };

// The project's own environment, without what would change how its tests run:
// under a node:test parent, NODE_TEST_CONTEXT makes a child `node --test`
// report to that parent and exit 0 whatever failed.
function projectEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	return { ...env, ...extra };
}

// TCP ports something listens on now (/proc/net/tcp, tcp6; state 0A = LISTEN).
// None where /proc has no such files.
export function listeningPorts(): number[] {
	const ports = new Set<number>();
	for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text = "";
		try {
			text = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const cols = line.trim().split(/\s+/);
			if (cols[3] === "0A") ports.add(Number.parseInt(cols[1].split(":").pop() ?? "", 16));
		}
	}
	return [...ports].filter((p) => p > 0).sort((a, b) => a - b);
}

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "gate-guard.cjs");

// The project's test and start command see the machine as the operator's clean
// container would: loopback ports that were already listening (the agent's own
// server, say) refuse connections (gate-guard.cjs).
function isolatedEnv(blocked: number[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const opts = [process.env.NODE_OPTIONS, `--require ${GUARD}`].filter(Boolean).join(" ");
	return projectEnv({ ...extra, NODE_OPTIONS: opts, NERD_GATE_BLOCKED_PORTS: blocked.join(",") });
}

const PORT_HOW =
	"Make the server read its port from the environment, e.g. `const port = process.env.PORT || 8000;`, and listen on that. Do not stop other servers to free a port: the operator's checker and the gate start yours with their own PORT.";

function sh(cmd: string, args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv = projectEnv()): Promise<Run> {
	return new Promise((res) => {
		execFile(cmd, args, { cwd, timeout, env, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
			res({ code, out: `${stdout}${stderr}` });
		});
	});
}

const git = (cwd: string, ...args: string[]) => sh("git", args, cwd, 30_000);

function tail(text: string, n = TAIL_LINES): string {
	const lines = text.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
	return lines.slice(-n).map((l) => `    ${l}`).join("\n");
}

const FAIL_LINE = /^\s*(not ok\b|✖|×)|Error\b|ECONNREFUSED|EADDRINUSE|\bexpected\b|\bactual\b/i;

/** What failed first (the runner's failure lines), then the end of the output. */
function testExcerpt(out: string): string {
	const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
	const hits = [...new Set(clean.split("\n").filter((l) => FAIL_LINE.test(l)).map((l) => l.trim()))].slice(0, 10);
	const refused = /ECONNREFUSED (127\.\d+\.\d+\.\d+|localhost|::1)/.test(clean)
		? "\n  A test connects to a server on this machine that the test did not start; in the operator's clean container nothing listens there. Start the server inside the test (on a free port, e.g. listen(0)) and stop it after."
		: "";
	return `${hits.map((l) => `    ${l}`).join("\n")}${hits.length ? "\n    ..." : ""}\n${tail(clean, 6)}${refused}`;
}

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no port"))));
		});
	});
}

function hasHtml(dir: string, depth = 3): boolean {
	if (depth < 0) return false;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		if (e.isFile() && /\.html?$/i.test(e.name)) return true;
		if (e.isDirectory() && hasHtml(join(dir, e.name), depth - 1)) return true;
	}
	return false;
}

function killTree(p: ChildProcess) {
	if (p.pid === undefined || p.exitCode !== null) return;
	try {
		process.kill(-p.pid, "SIGKILL");
	} catch {
		p.kill("SIGKILL");
	}
}

/** Start the command in its own process group; does it answer on PORT? */
async function serves(cmd: string, dir: string, wantHtml: boolean, blocked: number[]): Promise<string | undefined> {
	const port = await freePort();
	const p = spawn("sh", ["-c", `exec ${cmd}`], {
		cwd: dir,
		detached: true,
		env: isolatedEnv(blocked, { PORT: String(port), HOST: "127.0.0.1" }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	p.stdout?.on("data", (d) => (out += d));
	p.stderr?.on("data", (d) => (out += d));
	const url = `http://127.0.0.1:${port}/`;
	const t0 = Date.now();
	try {
		while (Date.now() - t0 < SERVE_MS) {
			if (p.exitCode !== null) {
				if (p.exitCode === 0) return undefined; // a CLI that ran and finished
				const inUse = /EADDRINUSE/.test(out) ? ` It was started with PORT=${port} and still tried a port that was taken. ${PORT_HOW}` : "";
				return `\`${cmd}\` exited with code ${p.exitCode} before serving anything.${inUse}\n${tail(out)}`;
			}
			try {
				const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
				const type = r.headers.get("content-type") ?? "";
				const body = await r.text();
				if (r.status >= 400) return `\`${cmd}\` answered GET / with HTTP ${r.status}.`;
				if (wantHtml && !/html/i.test(type) && !/^\s*</.test(body))
					return `\`${cmd}\` answered GET / with "${type || "no content-type"}", not an HTML page, though the project has .html files.`;
				return undefined;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		return `\`${cmd}\` started with PORT=${port} but nothing answered on ${url} within ${SERVE_MS / 1000} s. ${PORT_HOW} Output:\n${tail(out)}`;
	} finally {
		killTree(p);
	}
}

/** README sections that say how to check the work. */
export const CHECK_HEADING = /\b(check|checking|verify|verification|testing)\b|провер/i;
export const MAX_README_CHECKS = 5;

/**
 * The node/npm commands of the README's check sections that the gate runs
 * (prompt audit, ticket 059): a command the README offers the operator as a
 * check must pass in a clean clone. `npm test` (run above) and the start
 * command (a server: it does not exit) are left out; no such section is not a
 * failure.
 */
export function readmeChecks(readme: string, start: string | null): string[] {
	const seen = new Set<string>();
	return readmeCommands(readme, CHECK_HEADING)
		.filter((c) => !/^npm\s+(test|t|run\s+test|start|run\s+start)\s*$/.test(c) && c !== start)
		.filter((c) => !seen.has(c) && seen.add(c))
		.slice(0, MAX_README_CHECKS);
}

export interface GateResult {
	/** Not a git repository, or nothing to say: the gate stays silent. */
	failures: string[];
}

/**
 * Check the committed project in `cwd` as the operator's checker will.
 * `changed`: files (relative to cwd) to lint; undefined lints nothing.
 */
export async function checkProject(cwd: string, changed: string[] = []): Promise<GateResult> {
	const top = await git(cwd, "rev-parse", "--show-toplevel");
	if (top.code !== 0) return { failures: [] };
	const root = top.out.trim();
	const sub = relative(root, cwd);
	const failures: string[] = [];

	if ((await git(cwd, "rev-parse", "--verify", "-q", "HEAD")).code !== 0) {
		return { failures: ["Nothing is committed yet. Commit the work: the operator checks the committed state, not the working tree."] };
	}
	const dirty = (await git(root, "status", "--porcelain")).out.trim();
	if (dirty) {
		const files = dirty.split("\n").map((l) => l.slice(3));
		const more = files.length > 10 ? ` and ${files.length - 10} more` : "";
		failures.push(`Uncommitted changes: ${files.slice(0, 10).join(", ")}${more}. The checks below ran on the last commit; commit what belongs to the project (and .gitignore what does not, e.g. node_modules).`);
	}

	// Taken before anything of the project runs: the agent's own servers and the like.
	const blocked = listeningPorts();
	const tmp = mkdtempSync(join(tmpdir(), "nerd-gate-"));
	try {
		const clone = await sh("git", ["clone", "-q", "--no-hardlinks", root, join(tmp, "app")], tmp, 120_000);
		if (clone.code !== 0) return { failures: [...failures, `A clean clone of the repository failed:\n${tail(clone.out)}`] };
		const app = join(tmp, "app", sub);

		const pkgPath = join(app, "package.json");
		if (existsSync(pkgPath)) {
			let pkg: { scripts?: Record<string, string> } | undefined;
			try {
				pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			} catch (e) {
				failures.push(`package.json does not parse: ${(e as Error).message}`);
			}
			if (pkg) {
				const readmeName = ["README.md", "readme.md", "Readme.md", "README.MD", "README"].find((n) => existsSync(join(app, n)));
				const readme = readmeName ? readFileSync(join(app, readmeName), "utf8") : null;
				const test = pkg.scripts?.test;
				const install = await sh(
					"npm",
					[existsSync(join(app, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund", "--prefer-offline"],
					app,
					INSTALL_MS,
				);
				if (install.code !== 0) failures.push(`\`npm ${existsSync(join(app, "package-lock.json")) ? "ci" : "install"}\` in a clean clone failed:\n${tail(install.out)}`);
				if (!test || NPM_INIT_STUB.test(test)) {
					failures.push(
						`package.json has ${test ? "npm init's placeholder" : "no"} "test" script, so \`npm test\` ${test ? "fails" : "does nothing"}. Make scripts.test run the project's tests (for node:test files, e.g. "node --test").`,
					);
				} else if (install.code === 0) {
					const t = await sh("npm", ["test"], app, TEST_MS, isolatedEnv(blocked, { CI: "1" }));
					if (t.code !== 0) failures.push(`\`npm test\` in a clean clone exited with ${t.code ?? "a timeout"}:\n${testExcerpt(t.out)}`);
				}
				const start = startCommand(pkg, readme);
				if (!start.cmd) {
					failures.push(
						`No start command: ${start.why}. Add scripts.start to package.json, or a README with a "Run" (or "Запуск") section holding exactly one node/npm command, and say there how to check the result.`,
					);
				} else if (install.code === 0) {
					const s = await serves(start.cmd, app, hasHtml(app), blocked);
					if (s) failures.push(s);
				}
				if (readme && install.code === 0) {
					for (const c of readmeChecks(readme, start.cmd)) {
						const r = await sh("sh", ["-c", c], app, TEST_MS, isolatedEnv(blocked, { CI: "1" }));
						if (r.code !== 0) failures.push(`The README's check \`${c}\` in a clean clone exited with ${r.code ?? "a timeout"}:\n${testExcerpt(r.out)}`);
					}
				}
			}
		}

		const lint: string[] = [];
		for (const f of changed) {
			const p = join(app, f);
			if (!existsSync(p)) continue;
			const ps = lintFile(p);
			if (ps.length) lint.push(`  ${f}: ${ps.slice(0, 3).map((x) => `line ${x.line}: ${x.text}`).join("; ")}${ps.length > 3 ? ` (+${ps.length - 3})` : ""}`);
		}
		if (lint.length) failures.push(`Linter errors in committed files:\n${lint.join("\n")}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		if (existsSync(tmp)) console.error(`[done gate] left behind: ${tmp}`);
	}
	return { failures };
}

export function gateNote(failures: string[], round: number, max: number): string {
	return `[done gate ${round}/${max}] Before this counts as done, the harness checked the committed project in a clean clone, the way the operator's checker will. It found:

${failures.map((f, i) => `${i + 1}. ${f}`).join("\n\n")}

Fix each, commit, and then finish your reply again.`;
}

/** What changed in the repository: HEAD and the working tree's status. */
async function fingerprint(cwd: string): Promise<string> {
	const h = await git(cwd, "rev-parse", "-q", "HEAD");
	const s = await git(cwd, "status", "--porcelain");
	return `${h.out.trim()}\n${s.out}`;
}

/** Files changed since `base` (a commit, or none: everything tracked), plus the working tree's. */
async function changedSince(cwd: string, base: string | undefined): Promise<string[]> {
	const committed = base
		? await git(cwd, "diff", "--name-only", "--relative", base, "HEAD")
		: await git(cwd, "ls-files");
	const files = committed.out.split("\n").filter(Boolean);
	return [...new Set(files)];
}

/** The gate as a Pi extension. `notify` reports a round where a person can see it. */
export function doneGate(pi: ExtensionAPI, opts: { maxRounds: number; log?: (r: { round: number; failures: string[] }) => void }) {
	let base: string | undefined;
	let startFp = "";
	let wrote = false;
	let ranBash = false;
	let rounds = 0;

	pi.on("before_agent_start", async (_event, ctx) => {
		const cwd = ctx.cwd || process.cwd();
		const h = await git(cwd, "rev-parse", "-q", "--verify", "HEAD");
		base = h.code === 0 ? h.out.trim() : undefined;
		startFp = await fingerprint(cwd);
		wrote = false;
		ranBash = false;
		rounds = 0;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			if (!event.isError) wrote = true;
		} else if (event.toolName === "bash") ranBash = true;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || rounds >= opts.maxRounds) return;
		const cwd = ctx.cwd || process.cwd();
		const fp = await fingerprint(cwd);
		if (!wrote && !(ranBash && fp !== startFp)) return;
		const { failures } = await checkProject(cwd, await changedSince(cwd, base));
		wrote = false;
		ranBash = false;
		startFp = fp;
		if (!failures.length) return;
		rounds += 1;
		opts.log?.({ round: rounds, failures });
		return {
			entries: [{ type: "custom_message" as const, customType: "nerd-gate", content: gateNote(failures, rounds, opts.maxRounds), display: true }],
			continue: true,
		};
	});
}
