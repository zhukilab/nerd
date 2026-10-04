// Plays N matches (default 200) between each pair of adjacent bot levels and
// prints how often the stronger one wins.   node rank.js [games]
import { newMatch, playRound } from "./core.js";
import { LEVELS, makeBot } from "./bots.js";

const games = Number(process.argv[2] ?? 200);

function match(lo, hi) {
	const a = makeBot(lo);
	const b = makeBot(hi);
	const m = newMatch();
	for (let i = 0; i < 1000 && m.winner === null; i++) {
		const x = a.move();
		const y = b.move();
		playRound(m, x, y);
		a.observe(x, y);
		b.observe(y, x);
	}
	return m.winner;
}

for (let i = 1; i < LEVELS.length; i++) {
	const lo = LEVELS[i - 1];
	const hi = LEVELS[i];
	let wins = 0;
	for (let g = 0; g < games; g++) if (match(lo.level, hi.level) === 1) wins++;
	const pct = ((100 * wins) / games).toFixed(1);
	console.log(`level ${hi.level} (${hi.name}) vs level ${lo.level} (${lo.name}): level ${hi.level} wins ${wins}/${games} games (${pct}%)`);
}
