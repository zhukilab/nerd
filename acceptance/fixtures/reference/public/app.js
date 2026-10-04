import { ELEMENTS, NAMES, GLYPHS, newMatch, playRound } from "/core.js";
import { LEVELS, makeBot } from "/bots.js";

const $ = (id) => document.getElementById(id);
const RESULT = { win: "раунд ваш", lose: "раунд соперника", draw: "ничья" };
let mode = null; // { bot, match } or { room, token, timer }

for (const l of LEVELS) {
	const b = document.createElement("button");
	b.textContent = `Бот: ${l.name}`;
	b.onclick = () => startBot(l);
	$("bots").append(b);
}
for (const e of ELEMENTS) {
	const b = document.createElement("button");
	b.textContent = `${GLYPHS[e]} ${NAMES[e]}`;
	b.dataset.element = e;
	b.onclick = () => move(e);
	$("board").append(b);
}
$("online").onclick = createRoom;
$("again").onclick = () => {
	clearInterval(mode?.timer);
	history.pushState(null, "", "/");
	show(false);
};

function show(game) {
	$("menu").hidden = game;
	$("game").hidden = !game;
	$("again").hidden = true;
	$("status").textContent = "";
	setBoard(true);
}

function setBoard(enabled) {
	for (const b of $("board").children) b.disabled = !enabled;
}

function render(score, last, over, won) {
	$("score").textContent = `Счёт: ${score[0]} : ${score[1]}`;
	if (last) $("status").textContent = `Вы: ${NAMES[last.you]}, соперник: ${NAMES[last.opp]} — ${RESULT[last.result]}.`;
	if (over) {
		$("status").textContent += won ? " Матч окончен: вы победили!" : " Матч окончен: победил соперник.";
		setBoard(false);
		$("again").hidden = false;
	}
}

function startBot(l) {
	mode = { bot: makeBot(l.level), match: newMatch() };
	show(true);
	$("info").textContent = `Игра с ботом (${l.name}), до трёх побед.`;
	render([0, 0]);
}

async function call(path, data) {
	const r = await fetch(path, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {});
	return r.json();
}

async function createRoom() {
	const { room, token } = await call("/api/rooms", {});
	sessionStorage.setItem(`room-${room}`, token);
	history.pushState(null, "", `/?room=${room}`);
	enterRoom(room, token);
}

function enterRoom(room, token) {
	mode = { room, token };
	show(true);
	$("info").textContent = `Комната ${room}. Ссылка для соперника: ${location.href}`;
	mode.timer = setInterval(poll, 300);
	poll();
}

let seq = 0; // a poll answer older than the last move is dropped

async function poll() {
	const s = seq;
	const v = await call(`/api/rooms/${mode.room}?token=${mode.token}`);
	if (s !== seq) return;
	if (v.error) return ($("status").textContent = v.error);
	onView(v);
}

function onView(v) {
	if (v.players < 2) {
		setBoard(false);
		$("status").textContent = "Ждём соперника…";
		return;
	}
	render(v.score, v.last, v.over, v.won);
	if (v.over) return clearInterval(mode.timer);
	setBoard(!v.waiting);
	if (v.waiting) $("status").textContent = "Ход сделан, ждём соперника…";
}

async function move(e) {
	if (mode.bot) {
		const b = mode.bot.move();
		const r = playRound(mode.match, e, b);
		mode.bot.observe(b, e);
		render(mode.match.score, { you: e, opp: b, result: r }, mode.match.winner !== null, mode.match.winner === 0);
		return;
	}
	setBoard(false);
	seq++;
	onView(await call(`/api/rooms/${mode.room}/move`, { token: mode.token, move: e }));
}

const room = new URLSearchParams(location.search).get("room");
if (room) {
	const token = sessionStorage.getItem(`room-${room}`);
	if (token) enterRoom(room, token);
	else {
		const j = await call(`/api/rooms/${room}/join`, {});
		if (j.token) {
			sessionStorage.setItem(`room-${room}`, j.token);
			enterRoom(room, j.token);
		} else $("info").textContent = j.error;
	}
}
