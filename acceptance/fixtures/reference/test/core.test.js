import { test } from "node:test";
import assert from "node:assert/strict";
import { ELEMENTS, GENERATES, OVERCOMES, roundResult, newMatch, playRound } from "../core.js";
import { makeBot } from "../bots.js";

test("generation cycle", () => {
	assert.deepEqual(GENERATES, { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" });
});

test("overcoming cycle", () => {
	assert.deepEqual(OVERCOMES, { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" });
});

test("round result is antisymmetric", () => {
	const flip = { win: "lose", lose: "win", draw: "draw" };
	for (const a of ELEMENTS) for (const b of ELEMENTS) assert.equal(roundResult(b, a), flip[roundResult(a, b)]);
});

test("match ends at three wins", () => {
	const m = newMatch();
	for (let i = 0; i < 3; i++) playRound(m, "wood", "earth");
	assert.equal(m.winner, 0);
});

test("bots only play elements", () => {
	for (const level of [1, 2, 3]) {
		const b = makeBot(level);
		for (let i = 0; i < 20; i++) {
			const x = b.move();
			assert.ok(ELEMENTS.includes(x));
			b.observe(x, "wood");
		}
	}
});
