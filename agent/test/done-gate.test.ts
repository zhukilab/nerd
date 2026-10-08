// The done gate (done-gate.ts): a committed project is checked in a clean
// clone as the operator's checker would. Each case is a small git repository
// made here; the run-0006 delivery is used when its snapshot is given
// (NERD_GATE_R3=<ws-r3.tgz>, with workspace/ and its .git inside).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkProject, doneGateOn, doneGateRounds, gateNote, listeningPorts, readmeChecks } from "../src/done-gate.ts";
import { tempDir } from "./tmp.ts";

const on = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

function repo(files: Record<string, string>, commit = true): string {
	const d = tempDir("nerd-gate-test-");
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(d, name, ".."), { recursive: true });
		writeFileSync(join(d, name), text);
	}
	const g = (...a: string[]) => spawnSync("git", a, { cwd: d, stdio: "pipe" });
	g("init", "-q");
	g("config", "user.name", "t");
	g("config", "user.email", "t@t");
	if (commit) {
		g("add", "-A");
		g("commit", "-qm", "work");
	}
	return d;
}

const SERVER = `const http = require("node:http");
const port = Number(process.env.PORT || 8000);
http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end("<!doctype html><title>x</title>"); })
  .listen(port, () => console.log("http://localhost:" + port));
`;
const GOOD = {
	"package.json": JSON.stringify({ name: "g", version: "1.0.0", scripts: { test: "node --test", start: "node server.js" } }),
	"server.js": SERVER,
	"public/index.html": "<!doctype html><title>x</title>",
	"test/a.test.js": `const t = require("node:test"); const a = require("node:assert"); t.test("one", () => a.equal(1, 1));\n`,
	".gitignore": "node_modules\n",
};

test("done gate: on by default, rounds 2; NERD_DONE_GATE=0 off", () => {
	assert.equal(doneGateOn({}), true);
	assert.equal(doneGateOn({ NERD_DONE_GATE: "0" }), false);
	assert.equal(doneGateRounds({}), 2);
	assert.equal(doneGateRounds({ NERD_DONE_GATE_ROUNDS: "1" }), 1);
});

test("done gate: a correct node web project passes (no tokens)", async () => {
	const r = await checkProject(repo(GOOD), ["server.js"]);
	assert.deepEqual(r.failures, []);
});

test("done gate: start command from the README's run section passes too", async () => {
	const { "package.json": _, ...rest } = GOOD;
	const r = await checkProject(
		repo({
			...rest,
			"package.json": JSON.stringify({ name: "g", version: "1.0.0", scripts: { test: "node --test" } }),
			"README.md": "# G\n\n## Запуск\n\n```\nnode server.js\n```\n",
		}),
	);
	assert.deepEqual(r.failures, []);
});

test("done gate: npm init's test stub, no start command, no README fail", async () => {
	const r = await checkProject(
		repo({
			"package.json": JSON.stringify({ name: "w", version: "1.0.0", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
			"server.js": SERVER,
		}),
	);
	assert.equal(r.failures.length, 2, r.failures.join("\n---\n"));
	assert.match(r.failures[0], /placeholder "test" script/);
	assert.match(r.failures[1], /No start command: package.json has no scripts.start and there is no README/);
});

test("done gate: a server that ignores PORT, a failing test, uncommitted work", async () => {
	const d = repo({
		...GOOD,
		"server.js": SERVER.replace("Number(process.env.PORT || 8000)", "1"),
		"test/a.test.js": `const t = require("node:test"); const a = require("node:assert"); t.test("one", () => a.equal(1, 2));\n`,
	});
	writeFileSync(join(d, "later.js"), "// not committed\n");
	const r = await checkProject(d);
	const all = r.failures.join("\n---\n");
	assert.equal(r.failures.length, 3, all);
	assert.match(r.failures[0], /Uncommitted changes: later\.js/);
	assert.match(r.failures[1], /`npm test` in a clean clone exited with 1/);
	assert.match(r.failures[2], /must listen on the port in the PORT environment variable|exited with code/);
});

test("done gate: a CLI start command that exits 0 is not a server", async () => {
	const r = await checkProject(
		repo({
			"package.json": JSON.stringify({ name: "c", version: "1.0.0", scripts: { test: "node --test", start: "node cli.js" } }),
			"cli.js": "console.log('hello');\n",
			"test/a.test.js": GOOD["test/a.test.js"],
		}),
	);
	assert.deepEqual(r.failures, []);
});

test("done gate: not node — node rules do not apply; not git — no check", async () => {
	const r = await checkProject(repo({ "main.py": "print('hi')\n", "notes/rules.md": "# rules\n" }), ["main.py"]);
	assert.deepEqual(r.failures, []);
	assert.deepEqual((await checkProject(tempDir("nerd-gate-nogit-"))).failures, []);
	assert.match((await checkProject(repo({ "a.txt": "x" }, false))).failures[0], /Nothing is committed yet/);
});

test("done gate: linter errors in changed committed files", { skip: !on("biome") && "biome not on PATH" }, async () => {
	const r = await checkProject(repo({ "a.js": "console.log(undeclaredThing);\n" }), ["a.js"]);
	assert.equal(r.failures.length, 1);
	assert.match(r.failures[0], /Linter errors in committed files:\n {2}a\.js: line 1/);
});

test("done gate: the note numbers the failures and names the round", () => {
	const n = gateNote(["one", "two"], 1, 2);
	assert.match(n, /^\[done gate 1\/2\]/);
	assert.match(n, /1\. one\n\n2\. two/);
	assert.match(n, /Fix each, commit/);
});

const R3 = process.env.NERD_GATE_R3;
test("done gate: run 0006's last delivery (r3) is stopped", { skip: !(R3 && existsSync(R3)) && "NERD_GATE_R3 not given" }, async () => {
	const d = tempDir("nerd-gate-r3-");
	spawnSync("tar", ["xzf", R3 as string, "-C", d]);
	const r = await checkProject(join(d, "workspace"));
	const all = r.failures.join("\n---\n");
	assert.match(all, /placeholder "test" script/, all);
	assert.match(all, /No start command: package.json has no scripts.start and there is no README/, all);
});

// Run 0006 rerun: a test that talks to localhost:8000 without starting a
// server passed in the gate against the agent's own live server, and failed
// in the operator's clean container. Ports listening before the check are
// refused to the project's test and start command (gate-guard.cjs).
test("done gate: a test that relies on a server already running elsewhere fails, as in a clean container", async () => {
	const live = createServer((_q, r) => r.end("live")).listen(0, "127.0.0.1");
	await once(live, "listening");
	const port = (live.address() as AddressInfo).port;
	try {
		if (existsSync("/proc/net/tcp")) assert.ok(listeningPorts().includes(port), "the live port is seen as listening");
		const r = await checkProject(
			repo({
				...GOOD,
				"test/online.test.js": `const t = require("node:test"); const a = require("node:assert"); const http = require("node:http");
t.test("server answers", () => new Promise((ok, no) => http.get("http://localhost:${port}/", (res) => { a.equal(res.statusCode, 200); res.resume(); ok(); }).on("error", no)));
t.test("fetch answers", async () => { const r = await fetch("http://127.0.0.1:${port}/"); a.equal(r.status, 200); });
`,
			}),
		);
		assert.equal(r.failures.length, 1, r.failures.join("\n---\n"));
		assert.match(r.failures[0], /`npm test` in a clean clone exited with 1/);
		assert.match(r.failures[0], /ECONNREFUSED/);
	} finally {
		live.close();
	}
});

test("done gate: a server that insists on a taken port is told to read process.env.PORT", async () => {
	const live = createServer((_q, r) => r.end("live")).listen(0, "127.0.0.1");
	await once(live, "listening");
	const port = (live.address() as AddressInfo).port;
	try {
		const r = await checkProject(repo({ ...GOOD, "server.js": SERVER.replace("Number(process.env.PORT || 8000)", String(port)) }));
		assert.equal(r.failures.length, 1, r.failures.join("\n---\n"));
		assert.match(r.failures[0], /EADDRINUSE|nothing answered/);
		assert.match(r.failures[0], /process\.env\.PORT/);
		assert.match(r.failures[0], /Do not stop other servers/);
	} finally {
		live.close();
	}
});

test("done gate: the README's check commands run in the clean clone; a failing one is reported, none is fine", async () => {
	const readme = (cmd: string) => `# G\n\n## Запуск\n\n\`\`\`\nnpm start\n\`\`\`\n\n## Проверка\n\n\`\`\`\nnpm install\nnpm test\n${cmd}\n\`\`\`\n`;
	assert.deepEqual(readmeChecks(readme("node check.js"), "npm start"), ["node check.js"], "npm install/test and the start command are left out");
	assert.deepEqual(readmeChecks("# G\n\n## Run\n\n```\nnode server.js\n```\n", "node server.js"), [], "no check section: nothing to run");
	const ok = await checkProject(repo({ ...GOOD, "check.js": "console.log('ranks: 3 > 2 > 1');\n", "README.md": readme("node check.js") }));
	assert.deepEqual(ok.failures, []);
	const bad = await checkProject(repo({ ...GOOD, "check.js": "console.error('rank 3 lost to rank 2'); process.exit(1);\n", "README.md": readme("node check.js") }));
	assert.equal(bad.failures.length, 1, bad.failures.join("\n---\n"));
	assert.match(bad.failures[0], /README's check `node check\.js` in a clean clone exited with 1/);
	assert.match(bad.failures[0], /rank 3 lost to rank 2/);
});
