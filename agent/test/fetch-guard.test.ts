// The fetch guard (fetch-guard.ts): a note on a 404 for a made-up address and
// on npmjs.com's 403, nothing otherwise. Addresses are from the A/B of 048.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FetchGuard, fetchGuardOn, MADE_UP_NOTE, normalUrl, urlsIn } from "../src/fetch-guard.ts";

const SEARCH =
	"1. Largest remainders method - Wikipedia\n   https://en.wikipedia.org/wiki/Largest_remainders_method\n" +
	"2. slug - npm (https://www.npmjs.com/package/slug)\n3. <https://github.com/sindresorhus/slugify/>";

test("fetch guard: addresses from search results, compared without fragment, trailing slash or punctuation", () => {
	assert.deepEqual(urlsIn(SEARCH), [
		"https://en.wikipedia.org/wiki/Largest_remainders_method",
		"https://www.npmjs.com/package/slug",
		"https://github.com/sindresorhus/slugify",
	]);
	assert.equal(normalUrl("https://tc39.es/ecma262/#sec-x"), "https://tc39.es/ecma262");
	assert.equal(normalUrl("https://Example.org/a/?q=1"), "https://example.org/a?q=1");
});

test("fetch guard: a 404 for a guessed address gets the note, one from the results does not", () => {
	const g = new FetchGuard();
	g.searched(SEARCH);
	const guessed = "https://raw.githubusercontent.com/sindresorhus/slug/main/test.js";
	assert.equal(g.fetched(guessed, true, `HTTP 404 Not Found for ${guessed}`), MADE_UP_NOTE);
	const listed = "https://github.com/sindresorhus/slugify/";
	assert.equal(g.fetched(listed, true, `HTTP 404 Not Found for ${listed}`), undefined, "from the results: the page moved, no note");
	assert.equal(g.fetched(guessed, false, "page text"), undefined, "success: no note");
	assert.equal(g.fetched(guessed, true, "fetch failed: ETIMEDOUT"), undefined, "not a 404: no note");
	assert.equal(g.fetched("https://tc39.es/x", true, "HTTP 410 Gone for https://tc39.es/x"), MADE_UP_NOTE);
});

test("fetch guard: npmjs.com's 403 points at the registry", () => {
	const g = new FetchGuard();
	const note = g.fetched("https://www.npmjs.com/package/@scope/pkg", true, "HTTP 403 Forbidden for <url>");
	assert.match(note ?? "", /https:\/\/registry\.npmjs\.org\/@scope\/pkg$/);
	assert.equal(g.fetched("https://example.org/", true, "HTTP 403 Forbidden"), undefined, "another site's 403: no note");
});

test("fetch guard: on unless NERD_FETCH_GUARD=0", () => {
	assert.equal(fetchGuardOn({}), true);
	assert.equal(fetchGuardOn({ NERD_FETCH_GUARD: "1" }), true);
	assert.equal(fetchGuardOn({ NERD_FETCH_GUARD: "0" }), false);
});
