// Headless-browser part of the acceptance check (criteria 7, 8, 9, 13).
//   node browse.mjs <start-url> <out-dir>
// Writes <out-dir>/pages.json (texts and tables of the pages, for criterion 7)
// and <out-dir>/browser.json (results of the game drivers), screenshots in
// <out-dir>/shots/.
//
// The driver does not know the game's markup. It looks for controls by their
// visible text (button, link, role=button, input buttons, [onclick]):
//  - bot levels: text like easy/medium/hard, лёгкий/средний/сложный, level N;
//    if fewer than three are visible, it first clicks a "bot / computer" control;
//  - a network game: online / network / по сети / create room / с другом ...;
//  - moves: a control whose text names exactly one element (RU/EN/zh).
// It clicks random moves until the match ends: a "new game / again / заново"
// control appears that was not there when the match started, or a "game over /
// матч окончен / вы победили" line appears while no move control is enabled.
// Reaching that is PASS; anything else is left to the operator, with screenshots.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { elementsIn } from "../lib/rules.mjs";

const [start, outDir] = process.argv.slice(2);
mkdirSync(join(outDir, "shots"), { recursive: true });
const origin = new URL(start).origin;

const LEVEL = /\b(easy|weak|normal|medium|hard|strong|expert|novice|beginner|advanced|level\s*\d)\b|(?<!\p{L})(л[её]гк|слаб|средн|сложн|трудн|сильн|новичок|мастер|эксперт|уровень\s*\d|младш|старш)/iu;
const BOT = /\b(bot|bots|computer|ai|cpu)\b|(?<!\p{L})(бот|компьютер|ии)(?!\p{L})|ботом|ботам|против бота/iu;
const NET = /online|network|multiplayer|\bpvp\b|create (a )?(room|game)|host|with a friend|two players|2 players|по сети|сетев|онлайн|создать (комнату|игру)|с другом|против (человека|игрока|друга)|два игрока|комнат/iu;
const JOIN = /\bjoin\b|connect|присоедин|войти|подключ/iu;
const START = /\b(start|play|go|begin)\b|начать|играть|старт|в бой|поехали/iu;
const AGAIN = /new (game|match)|play again|again|restart|rematch|новая (игра|партия)|ещ[её] раз|заново|сыграть снова|снова|реванш|в меню|\bmenu\b/iu;
const OVER = /game over|match over|game (is )?finished|you (win|won|lose|lost)|winner|игра окончена|партия окончена|матч окончен|игра завершена|партия завершена|матч завершен|вы (победили|выиграли|проиграли)|победитель|поражение/iu;
const RULES = /rules|how to play|правила|как играть|справка/iu;

let shotN = 0;
async function shot(page, tag) {
	const f = `shots/${String(++shotN).padStart(3, "0")}-${tag}.png`;
	await page.screenshot({ path: join(outDir, f), fullPage: true }).catch(() => {});
	return f;
}

// Visible clickable controls, tagged with data-acc so they can be clicked.
async function scan(page) {
	return page
		.evaluate(() => {
			const sel = "button, a[href], [role=button], input[type=button], input[type=submit], [onclick], [data-element], [data-move]";
			let n = 0;
			const out = [];
			// Stale tags from an earlier scan would make ids ambiguous.
			for (const el of document.querySelectorAll("[data-acc]")) el.removeAttribute("data-acc");
			for (const el of document.querySelectorAll(sel)) {
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && (el.checkVisibility ? el.checkVisibility() : true);
				if (!visible) continue;
				const img = el.querySelector("img[alt]");
				const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || img?.alt || el.dataset.element || el.dataset.move || "").replace(/\s+/g, " ").trim();
				if (!text || text.length > 60) continue;
				const id = String(n++);
				el.setAttribute("data-acc", id);
				out.push({ id, text, enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true", href: el.getAttribute("href") });
			}
			return out;
		})
		.catch(() => []);
}

const isMove = (c) => c.text.length <= 30 && new Set(elementsIn(c.text).map((x) => x.el)).size === 1 && !LEVEL.test(c.text) && !NET.test(c.text);
const click = (page, c) => page.locator(`[data-acc="${c.id}"]`).first().click({ timeout: 3000 }).catch(() => {});
const text = (page) => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fillNames(page, name) {
	for (const inp of await page.locator("input[type=text]:visible, input:not([type]):visible").all()) {
		if (!(await inp.inputValue().catch(() => "x"))) await inp.fill(name).catch(() => {});
	}
}

// Snapshot taken when a match starts, to tell new end-of-match signs from old.
async function baseline(page) {
	return { controls: new Set((await scan(page)).map((c) => c.text)), lines: new Set((await text(page)).split("\n").map((s) => s.trim())) };
}

async function ended(page, base) {
	const cs = await scan(page);
	const again = cs.find((c) => c.enabled && AGAIN.test(c.text) && !base.controls.has(c.text) && !isMove(c));
	if (again) return `control "${again.text}" appeared`;
	if (cs.some((c) => isMove(c) && c.enabled)) return null;
	const fresh = (await text(page)).split("\n").map((s) => s.trim()).filter((s) => s && !base.lines.has(s));
	const over = fresh.find((s) => OVER.test(s));
	return over ? `text "${over.slice(0, 80)}" and no move control enabled` : null;
}

// Plays random moves on each page in turn until every page shows the end.
async function playUntilEnd(players, { maxRounds = 150, seconds = 240, onStep = async () => {} } = {}) {
	const bases = await Promise.all(players.map(baseline));
	const done = players.map(() => null);
	const deadline = Date.now() + seconds * 1000;
	let moves = 0;
	for (let round = 0; round < maxRounds && Date.now() < deadline && done.some((d) => !d); round++) {
		for (let i = 0; i < players.length; i++) {
			if (done[i]) continue;
			const page = players[i];
			let moved = false;
			for (let t = 0; t < 20 && !moved; t++) {
				if ((done[i] = await ended(page, bases[i]))) break;
				const ms = (await scan(page)).filter((c) => isMove(c) && c.enabled);
				if (ms.length) {
					await click(page, ms[Math.floor(Math.random() * ms.length)]);
					moved = true;
					moves++;
				} else await sleep(400);
			}
			await sleep(350);
			await onStep(page, moves);
		}
		for (let i = 0; i < players.length; i++) done[i] ||= await ended(players[i], bases[i]);
	}
	return { ended: done.every(Boolean), how: done, moves };
}

// Opens the start page and starts a bot match at level index i.
async function startBot(page, i) {
	await page.goto(start, { waitUntil: "load" });
	await sleep(500);
	await fillNames(page, "Tester");
	let levels = (await scan(page)).filter((c) => LEVEL.test(c.text) && !isMove(c) && !NET.test(c.text));
	if (levels.length < 3) {
		const bot = (await scan(page)).find((c) => BOT.test(c.text) && !NET.test(c.text) && !isMove(c));
		if (bot) {
			await click(page, bot);
			await sleep(500);
			levels = (await scan(page)).filter((c) => LEVEL.test(c.text) && !isMove(c) && !NET.test(c.text));
		}
	}
	const selects = levels.length < 3 ? await selectLevels(page) : null;
	const count = selects ? selects.count : levels.length;
	if (i >= count) return { ok: false, levels: count, names: levels.map((c) => c.text) };
	if (selects) await page.locator("select").nth(selects.index).selectOption({ index: selects.options[i] });
	else await click(page, levels[i]);
	await sleep(500);
	const cs = await scan(page);
	if (!cs.some((c) => isMove(c) && c.enabled)) {
		const go = cs.find((c) => START.test(c.text) && !isMove(c));
		if (go) await click(page, go);
		await sleep(500);
	}
	return { ok: true, levels: count, names: selects ? selects.names : levels.map((c) => c.text) };
}

async function selectLevels(page) {
	const all = await page.evaluate(() => [...document.querySelectorAll("select")].map((s) => [...s.options].map((o) => o.textContent.trim()))).catch(() => []);
	for (let index = 0; index < all.length; index++) {
		const options = all[index].map((t, k) => (LEVEL.test(t) ? k : -1)).filter((k) => k >= 0);
		if (options.length >= 3) return { index, options, count: options.length, names: options.map((k) => all[index][k]) };
	}
	return null;
}

async function overflow(page) {
	return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, innerWidth: window.innerWidth, metaViewport: !!document.querySelector('meta[name=viewport]') })).catch(() => null);
}

// ---------- criterion 7: pages ----------
async function crawl(browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const seen = new Set();
	const pages = [];
	let queue = [[start, 0]];
	while (queue.length && pages.length < 15) {
		const [url, depth] = queue.shift();
		const key = url.split("#")[0];
		if (seen.has(key)) continue;
		seen.add(key);
		const res = await page.goto(url, { waitUntil: "load" }).catch(() => null);
		if (!res || !(res.headers()["content-type"] ?? "").includes("html")) continue;
		await sleep(400);
		const p = await page.evaluate(() => ({
			text: document.body?.innerText ?? "",
			tables: [...document.querySelectorAll("table")].map((t) => [...t.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, " ").trim()))),
			links: [...document.querySelectorAll("a[href]")].map((a) => a.href),
		}));
		pages.push({ name: url, text: p.text, tables: p.tables, shot: await shot(page, "page") });
		if (depth < 2) for (const l of p.links) if (l.startsWith(origin)) queue.push([l, depth + 1]);
	}
	// Rules shown in place (a modal, a tab) behind a "rules" control on the start page.
	await page.goto(start, { waitUntil: "load" }).catch(() => {});
	for (const c of (await scan(page)).filter((c) => RULES.test(c.text) && !c.href)) {
		await click(page, c);
		await sleep(500);
		const p = await page.evaluate(() => ({ text: document.body?.innerText ?? "", tables: [...document.querySelectorAll("table")].map((t) => [...t.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, " ").trim()))) }));
		pages.push({ name: `${start} after clicking "${c.text}"`, text: p.text, tables: p.tables, shot: await shot(page, "rules-click") });
	}
	await ctx.close();
	return pages;
}

// ---------- criterion 9: a match with each bot level ----------
async function bots(browser) {
	const games = [];
	let levels = 0;
	for (let i = 0; i < 6; i++) {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		const s = await startBot(page, i);
		levels = s.levels;
		if (!s.ok) {
			await ctx.close();
			if (i === 0) games.push({ level: 1, ended: false, why: `no bot level controls found (seen: ${s.names.join(", ") || "none"})`, shot: await shot(page, "p9-nolevels") });
			break;
		}
		const r = await playUntilEnd([page]);
		games.push({ level: i + 1, name: s.names[i], ended: r.ended, how: r.how[0], moves: r.moves, shot: await shot(page, `p9-level${i + 1}`) });
		await ctx.close();
	}
	const all = games.length >= 3 && games.every((g) => g.ended);
	return {
		verdict: all ? "PASS" : "OPERATOR",
		why: all ? `${games.length} levels, each match played to its end` : levels < 3 ? `the driver found ${levels} bot level control(s), not three` : "the driver did not reach the end of every match",
		games,
	};
}

// ---------- criterion 8: two browsers, separate profiles ----------
async function network(browser) {
	const ca = await browser.newContext();
	const cb = await browser.newContext();
	const a = await ca.newPage();
	const b = await cb.newPage();
	const steps = [];
	try {
		await a.goto(start, { waitUntil: "load" });
		await sleep(500);
		await fillNames(a, "Alice");
		const net = (await scan(a)).find((c) => NET.test(c.text) && !isMove(c));
		if (!net) return { verdict: "OPERATOR", why: "no network-game control found on the start page", shots: [await shot(a, "p8-nonet")] };
		const before = a.url();
		const textBefore = await text(a);
		await click(a, net);
		steps.push(`A clicked "${net.text}"`);
		await sleep(1500);
		const shown = (await text(a)).match(/https?:\/\/\S+/g)?.find((u) => u.startsWith("http") && !textBefore.includes(u));
		if (a.url() !== before) {
			await b.goto(a.url(), { waitUntil: "load" });
			steps.push(`B opened A's address ${a.url()}`);
		} else if (shown) {
			await b.goto(shown.replace(/[).,]+$/, "").replace(/^https?:\/\/[^/]+/, origin), { waitUntil: "load" });
			steps.push(`B opened the link A shows: ${shown}`);
		} else {
			await b.goto(start, { waitUntil: "load" });
			await sleep(500);
			await fillNames(b, "Bob");
			const nb = (await scan(b)).find((c) => c.text === net.text) ?? (await scan(b)).find((c) => NET.test(c.text) && !isMove(c));
			if (nb) await click(b, nb);
			steps.push(`B opened the start page and clicked "${nb?.text}"`);
		}
		await sleep(1000);
		await fillNames(b, "Bob");
		const join = (await scan(b)).find((c) => JOIN.test(c.text) && c.enabled && !isMove(c));
		if (join) {
			await click(b, join);
			steps.push(`B clicked "${join.text}"`);
			await sleep(1000);
		}
		const shots = [await shot(a, "p8-A-start"), await shot(b, "p8-B-start")];
		const r = await playUntilEnd([a, b]);
		shots.push(await shot(a, "p8-A-end"), await shot(b, "p8-B-end"));
		return r.ended
			? { verdict: "PASS", why: `both browsers reached the end of the match (A: ${r.how[0]}; B: ${r.how[1]})`, steps, moves: r.moves, shots }
			: { verdict: "OPERATOR", why: `the driver did not reach the end in both browsers (A: ${r.how[0] ?? "no end"}; B: ${r.how[1] ?? "no end"})`, steps, moves: r.moves, shots };
	} finally {
		await ca.close();
		await cb.close();
	}
}

// ---------- criterion 13: 390 px, a bot match without horizontal scroll ----------
async function mobile(browser) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
	const page = await ctx.newPage();
	const worst = { over: 0, at: null, shot: null };
	const check = async (where) => {
		const o = await overflow(page);
		if (o && o.scrollWidth - o.clientWidth > worst.over) Object.assign(worst, { over: o.scrollWidth - o.clientWidth, at: where, shot: await shot(page, "p13-overflow"), o });
		return o;
	};
	try {
		await page.goto(start, { waitUntil: "load" });
		await sleep(500);
		const first = await check("start page");
		const s = await startBot(page, 0);
		await check("match started");
		const r = s.ok ? await playUntilEnd([page], { onStep: async (_, n) => check(`after move ${n}`) }) : { ended: false };
		await check("end");
		const endShot = await shot(page, "p13-end");
		const vp = first ? `layout width ${first.clientWidth}px, meta viewport ${first.metaViewport ? "present" : "absent"}` : "";
		if (worst.over > 1) return { verdict: "FAIL", why: `horizontal scroll: page ${worst.o.scrollWidth}px wide in ${worst.o.clientWidth}px (${worst.at}); ${vp}`, shots: [worst.shot, endShot] };
		if (!r.ended) return { verdict: "OPERATOR", why: `no horizontal scroll seen, but the driver did not finish a bot match; ${vp}`, shots: [endShot] };
		return { verdict: "PASS", why: `bot match played to the end at 390px, no horizontal scroll (${r.how[0]}); ${vp}`, shots: [endShot] };
	} finally {
		await ctx.close();
	}
}

const browser = await chromium.launch();
const result = {};
const pages = await crawl(browser);
writeFileSync(join(outDir, "pages.json"), JSON.stringify(pages, null, 1));
for (const [k, f] of [["p9", bots], ["p8", network], ["p13", mobile]]) {
	try {
		result[k] = await f(browser);
	} catch (e) {
		result[k] = { verdict: "OPERATOR", why: `the driver crashed: ${e.message.split("\n")[0]}` };
	}
}
await browser.close();
writeFileSync(join(outDir, "browser.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.verdict]))));
