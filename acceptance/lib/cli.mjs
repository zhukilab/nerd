// Steps of check.sh that run inside the app container (node:lts, curl).
//   node cli.mjs start-command <app-dir>      -> JSON { cmd, why }
//   node cli.mjs rank-command <app-dir>       -> JSON { cmd, why }
//   node cli.mjs rules-command <app-dir>      -> JSON { cmd, why }
//   node cli.mjs wait-http <server-log> <s>   -> JSON (criterion 6 evidence)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startCommand, rankCommand, findPorts } from "./parse.mjs";

const [cmd, ...args] = process.argv.slice(2);
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const readmeOf = (dir) => {
	for (const n of ["README.md", "readme.md", "Readme.md", "README.MD", "README"]) if (existsSync(join(dir, n))) return read(join(dir, n));
	return null;
};
const pkgOf = (dir) => {
	try {
		return JSON.parse(read(join(dir, "package.json")));
	} catch {
		return null;
	}
};
const print = (o) => console.log(JSON.stringify(o, null, 1));

function curl(url) {
	try {
		const out = execFileSync("curl", ["-sf", "-m", "5", "-o", "/tmp/acc-body", "-w", "%{http_code} %{content_type}", url], { encoding: "utf8" });
		const [code, ...ct] = out.trim().split(" ");
		const body = readFileSync("/tmp/acc-body", "utf8");
		return { ok: true, code: Number(code), contentType: ct.join(" "), body };
	} catch (e) {
		return { ok: false, rc: e.status };
	}
}

if (cmd === "start-command") print(startCommand(pkgOf(args[0]), readmeOf(args[0])));
else if (cmd === "rank-command") print(rankCommand(pkgOf(args[0]), readmeOf(args[0])));
else if (cmd === "rules-command") {
	const s = Object.keys(pkgOf(args[0])?.scripts ?? {}).filter((n) => /rules|правила/i.test(n));
	print(s.length === 1 ? { cmd: `npm run ${s[0]}`, why: `package.json script "${s[0]}"` } : { cmd: null, why: s.length ? `several rules-like scripts: ${s.join(", ")}` : "no rules-like script in package.json" });
} else if (cmd === "wait-http") {
	const [log, secs] = args;
	const deadline = Date.now() + Number(secs) * 1000;
	let tried = [];
	while (Date.now() < deadline) {
		const ports = [...new Set([...findPorts(read(log) ?? ""), 8000])];
		tried = ports;
		for (const p of ports) {
			const url = `http://127.0.0.1:${p}/`;
			const r = curl(url);
			if (r.ok) {
				const html = /text\/html/i.test(r.contentType) || /<html[\s>]/i.test(r.body);
				print({ verdict: html ? "PASS" : "FAIL", url, code: r.code, contentType: r.contentType, why: html ? `curl -sf ${url}: ${r.code}, ${r.contentType || "no content-type"}, HTML` : `curl -sf ${url} answered ${r.code} ${r.contentType}, but not HTML`, head: r.body.slice(0, 300) });
				process.exit(0);
			}
		}
		execFileSync("sleep", ["1"]);
	}
	print({ verdict: "FAIL", why: `no HTTP answer within ${secs} s on ports ${tried.join(", ")} (from the server's output, and 8000 = $PORT)` });
} else if (cmd === "field") {
	const v = JSON.parse(read(args[0]) ?? "{}")[args[1]];
	if (v != null) console.log(v);
} else if (cmd === "meta") {
	const e = process.env;
	print({
		input: e.ACC_INPUT,
		commit: e.ACC_COMMIT || undefined,
		uncommitted: Number(e.ACC_UNCOMMITTED) || undefined,
		image: e.ACC_IMAGE,
		node: process.version,
		npm: execFileSync("npm", ["-v"], { encoding: "utf8" }).trim(),
		browser: e.ACC_BROWSER,
		started: e.ACC_STARTED,
	});
} else {
	console.error("usage: cli.mjs start-command|rank-command|rules-command <dir> | wait-http <log> <s>");
	process.exit(2);
}
