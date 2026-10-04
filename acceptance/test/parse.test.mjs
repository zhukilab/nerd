import { test } from "node:test";
import assert from "node:assert/strict";
import { testCount, startCommand, rankCommand, findPorts, parseRank, judgeRank } from "../lib/parse.mjs";

test("test counts of common runners", () => {
	assert.equal(testCount("1..5\n# tests 5\n# pass 5\n").count, 5);
	assert.equal(testCount("ℹ tests 12\nℹ suites 0\n").count, 12);
	assert.equal(testCount("Tests:       1 failed, 9 passed, 10 total\n").count, 10);
	assert.equal(testCount(" Test Files  2 passed (2)\n      Tests  7 passed (7)\n").count, 7);
	assert.equal(testCount("\n  14 passing (20ms)\n").count, 14);
	assert.equal(testCount("# tests 3\n...\n# tests 4\n").count, 7);
	assert.equal(testCount("# tests 0\n").count, 0);
	assert.equal(testCount("all good\n").count, null);
});

test("start command rule", () => {
	assert.equal(startCommand({ scripts: { start: "node server.js" } }, "").cmd, "npm start");
	const md = "# Game\n\n## Запуск\n\n```sh\nnpm install\nnode src/server.js\n```\n";
	assert.equal(startCommand({ scripts: {} }, md).cmd, "node src/server.js");
	const two = "## Run\n```\n$ node a.js\n```\n## Start\n```\nnode b.js\n```\n";
	const r = startCommand({}, two);
	assert.equal(r.cmd, null);
	assert.match(r.why, /ambiguous/);
	assert.equal(startCommand({}, "# Game\nJust open it.\n").cmd, null);
});

test("rank command rule", () => {
	assert.equal(rankCommand({ scripts: { start: "x", rank: "node rank.js" } }, "").cmd, "npm run rank");
	assert.match(rankCommand({ scripts: { rank: "a", "bench:bots": "b" } }, "").why, /ambiguous/);
	const md = "## Ранги ботов\n\n```\nnode tools/ladder.js --games 200\n```\n";
	assert.equal(rankCommand({ scripts: {} }, md).cmd, "node tools/ladder.js --games 200");
});

test("ports named in server output", () => {
	assert.deepEqual(findPorts("Listening on http://0.0.0.0:3000\n"), [3000]);
	assert.deepEqual(findPorts("Сервер запущен на порту 8080"), [8080]);
	assert.deepEqual(findPorts("server port: 5173"), [5173]);
});

test("rank output in several shapes", () => {
	const ours = "level 2 (средний) vs level 1 (лёгкий): level 2 wins 194/200 games (97.0%)\nlevel 3 (сильный) vs level 2 (средний): level 3 wins 197/200 games (98.5%)\n";
	const p = parseRank(ours);
	assert.equal(p.length, 2);
	assert.equal(judgeRank(p).verdict, "PASS");

	const ru = "Средний против лёгкого: средний выиграл 150 из 200 партий\nСильный против среднего: сильный выиграл 130 из 200 партий\n";
	assert.equal(judgeRank(parseRank(ru)).verdict, "PASS");

	const eq = "easy vs medium (200 games): easy 49%, medium 51%\nmedium vs hard (200 games): medium 50%, hard 50%\n";
	const j = judgeRank(parseRank(eq));
	assert.equal(j.verdict, "FAIL");
	assert.match(j.why, /< 60%/);

	const few = "easy vs medium: medium wins 40/50\nmedium vs hard: hard wins 45/50\n";
	assert.match(judgeRank(parseRank(few)).why, /50 games < 200/);

	assert.equal(judgeRank(parseRank("done\n")).verdict, "FAIL");
});
