// Parsers for the acceptance checker (decision 0006, criteria 5, 6, 10).
// No dependencies: runs in the plain node:lts container next to the app.

// ---------- 5: how many tests ran ----------

// Summary lines of common runners. Each pattern yields a total for one run;
// totals of several runs in one log are added up (npm test may chain them).
const TEST_COUNT = [
	["node:test (TAP)", /^# tests (\d+)\s*$/gm],
	["node:test (spec)", /^\s*ℹ tests (\d+)\s*$/gm],
	["jest", /^Tests:\s+.*?(\d+) total/gm],
	["vitest", /^\s*Tests\s+.*?\((\d+)\)\s*$/gm],
	["mocha", /^\s*(\d+) passing\b/gm],
	["ava", /^\s*✔?\s*(\d+) tests? passed\b/gm],
];

// Returns { count, runner } or { count: null } when no known summary is found.
export function testCount(log) {
	const clean = log.replace(/\x1b\[[0-9;]*m/g, "");
	for (const [runner, re] of TEST_COUNT) {
		const hits = [...clean.matchAll(re)].map((m) => Number(m[1]));
		if (hits.length) return { count: hits.reduce((a, b) => a + b, 0), runner, runs: hits.length };
	}
	return { count: null };
}

// ---------- README: sections and fenced commands ----------

// Splits Markdown into sections by heading; fenced blocks are kept with the
// section they are in. Returns [{ heading, level, code: [lines], text }].
export function readmeSections(md) {
	const out = [{ heading: "", level: 0, code: [], text: "" }];
	let fence = null;
	for (const line of md.split(/\r?\n/)) {
		const cur = out.at(-1);
		const f = line.match(/^\s*(```|~~~)/);
		if (f) {
			fence = fence ? null : f[1];
			continue;
		}
		if (fence) {
			cur.code.push(line);
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) out.push({ heading: h[2].trim(), level: h[1].length, code: [], text: "" });
		else cur.text += line + "\n";
	}
	return out;
}

const SHELL_LINE = /^\s*(?:\$\s+)?((?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:npm|npx|node|yarn|pnpm)\b.*)$/;
const SETUP = /^(?:npm|yarn|pnpm)\s+(?:ci|i|install|add|test|t)\b|^npm\s+run\s+test\b/;

// Commands in fenced blocks of sections whose heading matches `headingRe`,
// minus setup commands (install, test). Distinct, in order.
export function readmeCommands(md, headingRe) {
	const found = [];
	for (const s of readmeSections(md)) {
		if (!headingRe.test(s.heading)) continue;
		for (const line of s.code) {
			const m = line.match(SHELL_LINE);
			if (!m) continue;
			const cmd = m[1].replace(/\s+#.*$/, "").trim();
			if (!SETUP.test(cmd) && !found.includes(cmd)) found.push(cmd);
		}
	}
	return found;
}

// ---------- 6: the start command ----------
//
// Rule: `npm start` when package.json has scripts.start. Otherwise the README:
// fenced blocks in sections headed like "run / start / launch / play / usage /
// запуск / старт / игра"; exactly one distinct node/npm command there is the
// start command. None or several: no command, and the reason says why.
export const START_HEADING = /\b(run|running|start|starting|launch|play|usage|getting started|quick ?start)\b|запуск|старт|запустить|играть|игра\b/i;

export function startCommand(pkg, readme) {
	if (pkg?.scripts?.start) return { cmd: "npm start", why: `package.json scripts.start = ${JSON.stringify(pkg.scripts.start)}` };
	if (readme == null) return { cmd: null, why: "package.json has no scripts.start and there is no README" };
	const c = readmeCommands(readme, START_HEADING);
	if (c.length === 1) return { cmd: c[0], why: "the only node/npm command in the README's run/start section" };
	if (!c.length) return { cmd: null, why: "package.json has no scripts.start and the README has no node/npm command in a run/start section" };
	return { cmd: null, why: `ambiguous: package.json has no scripts.start and the README's run/start sections give ${c.length} commands: ${c.join(" | ")}` };
}

// Ports the server's output names: http://host:NNNN, "port NNNN", "порт NNNN".
export function findPorts(log) {
	const ports = [];
	for (const m of log.matchAll(/https?:\/\/[^\s/:]+:(\d{2,5})|(?<!\p{L})(?:port|порт|порту)\s*:?\s*(\d{2,5})(?!\d)/giu)) {
		const p = Number(m[1] ?? m[2]);
		if (p > 0 && p < 65536 && !ports.includes(p)) ports.push(p);
	}
	return ports;
}

// ---------- 10: the rank command and its output ----------
//
// Rule: one package.json script whose name looks like ranking (rank, ladder,
// tournament, arena, elo, bench, strength, bots) -> `npm run <name>`. Else the
// README: fenced node/npm commands in sections headed like rank / ladder /
// bots / strength / ранг / бот / сил. Exactly one, or it is a failure.
const RANK_SCRIPT = /rank|ladder|tournament|arena|elo|bench|strength|bots?\b|ранг/i;
export const RANK_HEADING = /rank|ladder|tournament|arena|strength|\bbots?\b|ранг|бот|сил[аеуы]|турнир/i;

export function rankCommand(pkg, readme) {
	const scripts = Object.keys(pkg?.scripts ?? {}).filter((n) => RANK_SCRIPT.test(n) && !/^(start|test)$/.test(n));
	if (scripts.length === 1) return { cmd: `npm run ${scripts[0]}`, why: `package.json script "${scripts[0]}" = ${JSON.stringify(pkg.scripts[scripts[0]])}` };
	if (scripts.length > 1) return { cmd: null, why: `ambiguous: several ranking-like scripts in package.json: ${scripts.join(", ")}` };
	if (readme == null) return { cmd: null, why: "no ranking-like script in package.json and no README" };
	const c = readmeCommands(readme, RANK_HEADING);
	if (c.length === 1) return { cmd: c[0], why: "the only node/npm command in the README's rank/bots section" };
	if (!c.length) return { cmd: null, why: "no ranking-like script in package.json and no node/npm command in a rank/bots section of the README" };
	return { cmd: null, why: `ambiguous: the README's rank/bots sections give ${c.length} commands: ${c.join(" | ")}` };
}

// Level words, ordered weakest first within each scale. A token's rank is its
// index; scales are not mixed within one output.
const SCALES = [
	[/\b(?:level|lvl|уровень|ур\.?)\s*(\d+)\b|\bL(\d+)\b/i, (m) => Number(m[1] ?? m[2])],
	[/\b(easy|weak|normal|medium|hard|strong|expert|insane)\b/i, (m) => ({ easy: 1, weak: 1, normal: 2, medium: 2, hard: 3, strong: 3, expert: 4, insane: 5 })[m[1].toLowerCase()]],
	[/(?<!\p{L})(л[её]гк|слаб|средн|сложн|трудн|сильн|эксперт|мастер)\p{L}*/iu, (m) => ({ "лёгк": 1, "легк": 1, "слаб": 1, "средн": 2, "сложн": 3, "трудн": 3, "сильн": 3, "эксперт": 4, "мастер": 4 })[m[1].toLowerCase()]],
	[/(?<!\p{L})(младш|средн|старш)\p{L}*/iu, (m) => ({ "младш": 1, "средн": 2, "старш": 3 })[m[1].toLowerCase()]],
	[/\b(novice|beginner|intermediate|advanced|master)\b/i, (m) => ["novice", "beginner", "intermediate", "advanced", "master"].indexOf(m[1].toLowerCase()) + 1],
];

function levelTokens(line) {
	for (const [re, rank] of SCALES) {
		const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
		const toks = [...line.matchAll(g)].map((m) => ({ rank: rank(m), at: m.index, text: m[0] }));
		if (toks.length) return toks;
	}
	return [];
}

const GAMES = /(\d+)\s*(?:games|matches|партий|партии|игр|матчей)\b|\b(?:games|matches|партий|игр|n)\s*[=:]\s*(\d+)/iu;

// Parses a rank command's output into pairs { lo, hi, games, hiWinPct, line }.
// Per line: two distinct level tokens; the higher side's share comes from
// "W/N" or "W of N" or "NN%" attributed to the nearest level token before it.
// Lines it cannot read are skipped; the caller decides what a missing pair means.
export function parseRank(log) {
	const pairs = [];
	for (const raw of log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
		const line = raw.trim();
		const toks = levelTokens(line);
		const ranks = [...new Set(toks.map((t) => t.rank))];
		if (ranks.length !== 2) continue;
		const [lo, hi] = ranks.sort((a, b) => a - b);
		const share = {};
		let games = null;
		const owner = (at) => toks.filter((t) => t.at < at).at(-1)?.rank;
		for (const m of line.matchAll(/(\d+)\s*(?:\/|из|of|out of)\s*(\d+)/giu)) {
			const who = owner(m.index);
			if (who != null && share[who] == null) share[who] = (100 * Number(m[1])) / Number(m[2]);
			games ??= Number(m[2]);
		}
		for (const m of line.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
			const who = owner(m.index);
			if (who != null && share[who] == null) share[who] = Number(m[1].replace(",", "."));
		}
		const g = line.match(GAMES);
		if (g) games = Number(g[1] ?? g[2]);
		const hiWinPct = share[hi];
		if (hiWinPct == null) continue;
		pairs.push({ lo, hi, games, hiWinPct, line });
	}
	return pairs;
}

// Criterion 10 on parsed pairs: every adjacent pair of the levels seen has
// >= minGames games and the higher level wins >= minPct.
export function judgeRank(pairs, { minGames = 200, minPct = 60 } = {}) {
	if (!pairs.length) return { verdict: "FAIL", why: "no line of the output names two bot levels with a win share" };
	const levels = [...new Set(pairs.flatMap((p) => [p.lo, p.hi]))].sort((a, b) => a - b);
	const problems = [];
	if (levels.length < 3) problems.push(`only ${levels.length} levels in the output (answer sheet: at least three)`);
	for (let i = 1; i < levels.length; i++) {
		const p = pairs.find((q) => q.lo === levels[i - 1] && q.hi === levels[i]);
		if (!p) problems.push(`no result for adjacent levels ${levels[i - 1]}-${levels[i]}`);
		else {
			if (p.games == null) problems.push(`levels ${p.lo}-${p.hi}: number of games not found`);
			else if (p.games < minGames) problems.push(`levels ${p.lo}-${p.hi}: ${p.games} games < ${minGames}`);
			if (p.hiWinPct < minPct) problems.push(`levels ${p.lo}-${p.hi}: stronger wins ${p.hiWinPct.toFixed(1)}% < ${minPct}%`);
		}
	}
	return problems.length ? { verdict: "FAIL", why: problems.join("; "), levels } : { verdict: "PASS", why: `adjacent pairs ${levels.join("<")}: all >= ${minGames} games, stronger >= ${minPct}%`, levels };
}
