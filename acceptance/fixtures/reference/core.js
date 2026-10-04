// Wu xing rules: the two cycles, and how a round is scored.
// Shared by the server, the browser (served as /core.js) and the bots.
export const ELEMENTS = ["wood", "fire", "earth", "metal", "water"];

export const NAMES = {
	wood: "Дерево",
	fire: "Огонь",
	earth: "Земля",
	metal: "Металл",
	water: "Вода",
};

export const GLYPHS = { wood: "木", fire: "火", earth: "土", metal: "金", water: "水" };

// Generation (sheng): each element feeds the next.
export const GENERATES = { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" };

// Overcoming (ke): each element overcomes the one two steps ahead.
export const OVERCOMES = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };

export const WINS_NEEDED = 3;

// Scoring: overcoming the opponent's element wins the round; anything else
// (same element, generation, unrelated) is a draw.
export function roundResult(a, b) {
	if (OVERCOMES[a] === b) return "win";
	if (OVERCOMES[b] === a) return "lose";
	return "draw";
}

// The element that overcomes x.
export function counter(x) {
	return ELEMENTS.find((y) => OVERCOMES[y] === x);
}

export function newMatch() {
	return { score: [0, 0], rounds: [], winner: null };
}

// Applies one round to the match and returns the round's result for player 0.
export function playRound(match, m0, m1) {
	const r = roundResult(m0, m1);
	if (r === "win") match.score[0]++;
	if (r === "lose") match.score[1]++;
	match.rounds.push([m0, m1, r]);
	if (match.score[0] >= WINS_NEEDED) match.winner = 0;
	if (match.score[1] >= WINS_NEEDED) match.winner = 1;
	return r;
}
