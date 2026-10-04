// HTTP server: static files, the rules page, and rooms for the network game
// (two players, polling). Port: $PORT, default 8000; address $HOST, default 0.0.0.0.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join } from "node:path";
import { ELEMENTS, NAMES, GLYPHS, GENERATES, OVERCOMES, WINS_NEEDED, newMatch, playRound } from "./core.js";

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "0.0.0.0";
const root = new URL(".", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const FILES = {
	"/": "public/index.html",
	"/app.js": "public/app.js",
	"/style.css": "public/style.css",
	"/core.js": "core.js",
	"/bots.js": "bots.js",
};

function rulesPage() {
	const rows = ELEMENTS.map(
		(e) => `<tr><td>${GLYPHS[e]} ${NAMES[e]}</td><td>${NAMES[GENERATES[e]]}</td><td>${NAMES[OVERCOMES[e]]}</td></tr>`,
	).join("\n");
	return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Правила у-син</title>
<link rel="stylesheet" href="/style.css"></head><body><main>
<h1>Правила</h1>
<table><thead><tr><th>Стихия</th><th>Порождает</th><th>Преодолевает</th></tr></thead>
<tbody>${rows}</tbody></table>
<h2>Как считаются очки</h2>
<p>Если ваша стихия преодолевает стихию соперника, вы выигрываете раунд и получаете очко.
Порождение очков не даёт: такой раунд, как и одинаковые стихии, — ничья.
Матч идёт до ${WINS_NEEDED} побед.</p>
<p><a href="/">К игре</a></p>
</main></body></html>`;
}

const rooms = new Map();

function view(room, seat) {
	const m = room.match;
	const last = m.rounds.at(-1);
	return {
		seat,
		players: room.tokens.filter(Boolean).length,
		score: seat === 0 ? m.score : [m.score[1], m.score[0]],
		waiting: room.moves[seat] !== null,
		round: m.rounds.length + 1,
		last: last && { you: last[seat], opp: last[1 - seat], result: seat === 0 ? last[2] : { win: "lose", lose: "win", draw: "draw" }[last[2]] },
		over: m.winner !== null,
		won: m.winner === seat,
	};
}

async function body(req) {
	let s = "";
	for await (const c of req) s += c;
	return s ? JSON.parse(s) : {};
}

function send(res, code, type, data) {
	res.writeHead(code, { "content-type": type });
	res.end(data);
}

const json = (res, code, obj) => send(res, code, "application/json", JSON.stringify(obj));

async function api(req, res, parts) {
	if (req.method === "POST" && parts.length === 1) {
		const id = randomBytes(3).toString("hex");
		const token = randomBytes(8).toString("hex");
		rooms.set(id, { tokens: [token, null], moves: [null, null], match: newMatch() });
		return json(res, 200, { room: id, token });
	}
	const room = rooms.get(parts[1]);
	if (!room) return json(res, 404, { error: "no such room" });
	if (req.method === "POST" && parts[2] === "join") {
		if (room.tokens[1]) return json(res, 409, { error: "room is full" });
		room.tokens[1] = randomBytes(8).toString("hex");
		return json(res, 200, { room: parts[1], token: room.tokens[1] });
	}
	const q = req.method === "GET" ? Object.fromEntries(new URL(req.url, "http://x").searchParams) : await body(req);
	const seat = room.tokens.indexOf(q.token);
	if (seat < 0) return json(res, 403, { error: "bad token" });
	if (req.method === "POST" && parts[2] === "move") {
		if (!ELEMENTS.includes(q.move) || room.match.winner !== null || !room.tokens[1]) return json(res, 400, { error: "move not allowed" });
		room.moves[seat] = q.move;
		if (room.moves[0] && room.moves[1]) {
			playRound(room.match, room.moves[0], room.moves[1]);
			room.moves = [null, null];
		}
	}
	return json(res, 200, view(room, seat));
}

http
	.createServer(async (req, res) => {
		try {
			const path = new URL(req.url, "http://x").pathname;
			const parts = path.split("/").filter(Boolean);
			if (parts[0] === "api" && parts[1] === "rooms") return await api(req, res, parts.slice(1));
			if (path === "/rules") return send(res, 200, TYPES[".html"], rulesPage());
			const file = FILES[path];
			if (!file) return send(res, 404, "text/plain", "not found");
			send(res, 200, TYPES[extname(file)], await readFile(join(root, file)));
		} catch (e) {
			send(res, 500, "text/plain", String(e));
		}
	})
	.listen(port, host, () => console.log(`Wu xing game on http://localhost:${port}/`));
