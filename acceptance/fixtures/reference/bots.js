// Three bot levels. Each bot sees the history of the current match only.
//   1 easy:   repeats its own last move with probability 0.6, else random.
//   2 medium: expects the opponent to repeat, plays what overcomes that.
//   3 hard:   keeps score of two predictions (opponent repeats; opponent
//             counters my last move) and follows the one that has been right
//             more often.
import { ELEMENTS, counter } from "./core.js";

export const LEVELS = [
	{ level: 1, name: "лёгкий" },
	{ level: 2, name: "средний" },
	{ level: 3, name: "сильный" },
];

export function makeBot(level, rng = Math.random) {
	const pick = () => ELEMENTS[Math.floor(rng() * ELEMENTS.length)];
	const mine = [];
	const theirs = [];
	const hits = { repeat: 0, counter: 0 };
	return {
		level,
		move() {
			const myLast = mine.at(-1);
			const oppLast = theirs.at(-1);
			if (!myLast) return pick();
			if (level === 1) return rng() < 0.6 ? myLast : pick();
			if (rng() < 0.1) return pick();
			if (level === 2) return counter(oppLast);
			const predicted = hits.counter > hits.repeat ? counter(myLast) : oppLast;
			return counter(predicted);
		},
		observe(my, opp) {
			if (mine.length) {
				if (opp === theirs.at(-1)) hits.repeat++;
				if (opp === counter(mine.at(-1))) hits.counter++;
			}
			mine.push(my);
			theirs.push(opp);
		},
	};
}
