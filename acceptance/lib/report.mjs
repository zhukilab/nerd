// Builds report.json and report.md from the evidence check.sh left in <out>.
//   node report.mjs <out-dir>
// Verdicts: PASS, FAIL, OPERATOR (left to the operator's observation).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testCount, parseRank, judgeRank } from "./parse.mjs";
import { tableEdges, textEdges, judgeRules, scoringSentence } from "./rules.mjs";

const out = process.argv[2];
const f = (n) => join(out, n);
const read = (n) => (existsSync(f(n)) ? readFileSync(f(n), "utf8") : null);
const json = (n) => {
	try {
		return JSON.parse(read(n));
	} catch {
		return null;
	}
};
const rc = (n) => (read(n) == null ? null : Number(read(n).trim()));

const meta = json("meta.json") ?? {};
const R = {};

// ---- 5 ----
{
	const ci = rc("p5-npm-ci.rc");
	const t = rc("p5-npm-test.rc");
	const n = testCount(read("p5-npm-test.log") ?? "");
	const ev = ["p5-npm-ci.log", "p5-npm-test.log"];
	if (ci !== 0) R.P5 = { verdict: "FAIL", why: `npm ci exited ${ci}`, evidence: ev };
	else if (t !== 0) R.P5 = { verdict: "FAIL", why: `npm test exited ${t}`, evidence: ev };
	else if (n.count == null) R.P5 = { verdict: "OPERATOR", why: "npm test exited 0, but the number of tests is not in any summary format the checker knows (node:test, jest, vitest, mocha, ava)", evidence: ev };
	else if (n.count === 0) R.P5 = { verdict: "FAIL", why: `npm test exited 0 with 0 tests (${n.runner})`, evidence: ev };
	else R.P5 = { verdict: "PASS", why: `npm ci and npm test exited 0; ${n.count} tests (${n.runner}${n.runs > 1 ? `, ${n.runs} runs` : ""})`, evidence: ev };
}

// ---- 6 ----
const start = json("p6-command.json") ?? {};
const p6 = json("p6.json");
if (!start.cmd) R.P6 = { verdict: "FAIL", why: `no start command: ${start.why ?? "not determined"}`, evidence: ["p6-command.json"] };
else if (!p6) R.P6 = { verdict: "FAIL", why: `started "${start.cmd}", no result recorded`, evidence: ["p6-server.log"] };
else R.P6 = { verdict: p6.verdict, why: `"${start.cmd}" (${start.why}); ${p6.why}`, evidence: ["p6-command.json", "p6-server.log", "p6.json"] };
const served = R.P6.verdict === "PASS";

// ---- 7 ----
{
	const pages = json("browser/pages.json") ?? [];
	const sources = [];
	for (const p of pages) {
		p.tables.forEach((t, k) => sources.push({ name: `${p.name} table ${k + 1}`, page: p, edges: tableEdges(t) }));
		sources.push({ name: `${p.name} text`, page: p, edges: textEdges(p.text) });
	}
	const cmdOut = read("p7-rules-cmd.log");
	if (cmdOut != null) sources.push({ name: "rules command output", page: { name: "rules command output", text: cmdOut }, edges: textEdges(cmdOut) });
	const j = judgeRules(sources);
	const ev = ["p7-rules.json", ...pages.map((p) => `browser/${p.shot}`)];
	writeFileSync(f("p7-rules.json"), JSON.stringify({ judgement: j, sources: sources.map((s) => ({ name: s.name, edges: s.edges })) }, null, 1));
	if (!served && cmdOut == null) R.P7 = { verdict: "FAIL", why: "nothing to check: no server (P6) and no rules command", evidence: [] };
	else if (j.verdict !== "PASS") R.P7 = { verdict: j.verdict, why: j.why, evidence: ev };
	else {
		const src = sources.find((s) => s.name === j.page);
		const sc = scoringSentence(src.page.text);
		R.P7 = sc
			? { verdict: "PASS", why: `${j.why} (${j.page}); scoring described on the same page: "${sc.slice(0, 200)}"`, evidence: ev }
			: { verdict: "OPERATOR", why: `${j.why} (${j.page}), but no sentence about scoring was recognised on that page`, evidence: ev };
	}
}

// ---- 8, 9, 13 ----
const br = json("browser/browser.json");
const shots = (r) => [...(r?.shots ?? []), ...(r?.games ?? []).map((g) => g.shot)].filter(Boolean).map((s) => `browser/${s}`);
for (const [k, key] of [["P8", "p8"], ["P9", "p9"], ["P13", "p13"]]) {
	if (!served) R[k] = { verdict: "FAIL", why: "not checked: no server (P6)", evidence: [] };
	else if (!br?.[key]) R[k] = { verdict: "OPERATOR", why: "the browser step left no result", evidence: ["browser.log"] };
	else {
		const r = br[key];
		const games = r.games ? "; " + r.games.map((g) => `level ${g.level}${g.name ? ` "${g.name}"` : ""}: ${g.ended ? `ended after ${g.moves} moves (${g.how})` : g.why ?? "no end reached"}`).join("; ") : "";
		const steps = r.steps ? `; ${r.steps.join(", ")}` : "";
		R[k] = { verdict: r.verdict, why: r.why + steps + games, evidence: ["browser/browser.json", ...shots(r)] };
	}
}
R.P13.note = "decision 0006 checks P13 after remark 3; measured on every version anyway";

// ---- 10 ----
{
	const c = json("p10-command.json") ?? {};
	if (!c.cmd) R.P10 = { verdict: "FAIL", why: `no rank command: ${c.why ?? "not determined"}`, evidence: ["p10-command.json"] };
	else {
		const code = rc("p10.rc");
		const log = read("p10-rank.log") ?? "";
		const j = judgeRank(parseRank(log));
		const ev = ["p10-command.json", "p10-rank.log"];
		if (code !== 0) R.P10 = { verdict: "FAIL", why: `"${c.cmd}" exited ${code}${code === 124 ? " (timeout)" : ""}`, evidence: ev };
		else R.P10 = { verdict: j.verdict, why: `"${c.cmd}" (${c.why}): ${j.why}`, evidence: ev };
	}
}

const order = ["P5", "P6", "P7", "P8", "P9", "P10", "P13"];
const report = { checked: meta, criteria: Object.fromEntries(order.map((k) => [k, R[k]])) };
writeFileSync(f("report.json"), JSON.stringify(report, null, 1));

const md = [
	`# Acceptance check (decision 0006)`,
	"",
	`- input: ${meta.input ?? "?"}${meta.commit ? ` at ${meta.commit}` : ""}${meta.uncommitted ? ` (${meta.uncommitted} uncommitted paths not included)` : ""}`,
	`- clean container: ${meta.image ?? "?"}, node ${meta.node ?? "?"}, npm ${meta.npm ?? "?"}; browser: ${meta.browser ?? "?"}`,
	`- started: ${meta.started ?? "?"}`,
	"",
	"| criterion | verdict | why |",
	"|---|---|---|",
	...order.map((k) => `| ${k} | **${R[k].verdict}** | ${R[k].why.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
	"",
	"Evidence (paths relative to this directory):",
	"",
	...order.map((k) => `- ${k}: ${R[k].evidence.join(", ") || "—"}`),
	"",
	"OPERATOR = the checker could not decide; the operator looks at the evidence. Not checked here: P1–P4, P11, P12 (dialogue log and timing).",
	"",
].join("\n");
writeFileSync(f("report.md"), md);
console.log(order.map((k) => `${k} ${R[k].verdict}`).join("  "));
