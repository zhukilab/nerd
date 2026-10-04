// Criterion 7: find the two wu xing cycles in what the game shows (page text,
// HTML tables, or a command's output) and compare them with the canon.
//
// Heuristic, written down so a verdict can be argued with:
//  - Elements are recognised by name in Russian (with case endings), English
//    and Chinese (木火土金水), whatever the game calls them otherwise is not.
//  - A relation is named by a keyword: generation (generate, feed, produce,
//    create, nourish, sheng, 生, порождает, питает, рождает, создаёт,
//    подпитывает) or overcoming (overcome, destroy, control, conquer, defeat,
//    beat, restrain, ke, 克, преодолевает, подавляет, разрушает, побеждает,
//    бьёт, сдерживает, контролирует). A passive form ("is fed by",
//    "порождается") reverses the direction.
//  - Tables: a header cell with a relation keyword makes that column the
//    target of "row element -> relation -> cell element".
//  - Text: each line (and sentence) with one relation keyword gives edges
//    between consecutive element names; a line with elements but no keyword
//    takes the relation of a keyword-only line (a heading) up to 3 lines above.
//  - A source (one table, or one page's text) "claims" a relation when it
//    yields >= 4 edges of it. A claim that is exactly the canonical 5-edge
//    cycle is right; any other claim is wrong.
// PASS needs a right claim for both relations and no wrong claim; a wrong
// claim is FAIL; anything else (nothing parsed, partial) is for the operator.

export const ELEMENTS = ["wood", "fire", "earth", "metal", "water"];
export const CANON = {
	generation: { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" },
	overcoming: { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" },
};

const L = "\\p{L}";
const ru = (stem, ends) => `(?<!${L})${stem}(?:${ends})(?!${L})`;
const NAME_RE = {
	wood: [ru("дерев", "о|а|у|ом|е|ья|ьев"), ru("древесин", "а|ы|у|ой|е"), "\\bwood(?:en)?\\b", "木"],
	fire: [ru("ог", "онь|ня|ню|нём|нем|ни"), "\\bfire\\b", "火"],
	earth: [ru("земл", "я|и|ю|ёй|ей|е"), ru("почв", "а|ы|у|ой|е"), "\\bearth\\b", "\\bsoil\\b", "土"],
	metal: [ru("металл", "|а|у|ом|е|ы"), ru("метал", "|а|у|ом|е"), "\\bmetal\\b", "金"],
	water: [ru("вод", "а|ы|у|ой|ою|е"), "\\bwater\\b", "水"],
};
const ANY_NAME = new RegExp(
	Object.entries(NAME_RE)
		.map(([e, alts]) => `(?<${e}>${alts.join("|")})`)
		.join("|"),
	"giu",
);

// Element mentions in order: [{ el, at, text }].
export function elementsIn(text) {
	const out = [];
	for (const m of text.matchAll(ANY_NAME)) {
		const el = ELEMENTS.find((e) => m.groups[e] !== undefined);
		out.push({ el, at: m.index, text: m[0] });
	}
	return out;
}

const GEN_ACTIVE = /generat|\bfeeds?\b|\bfeeding\b|produc|\bcreates?\b|nourish|\bsheng\b|生|порожда|(?<!\p{L})пита(?:ет|ют|ть)|подпитыва|рожда(?:ет|ют)|созда[её]т|созда(?:ют)/iu;
const GEN_PASSIVE = /(?:generated|produced|fed|created|nourished)\s+by|порожда[её]тся|(?<!\p{L})пита[её]тся|рожда[её]тся|созда[её]тся|подпитыва[её]тся|порожд[её]н/iu;
const KE_ACTIVE = /overcom|destroy|\bcontrols?\b|controlling|conquer|defeat|\bbeats?\b|restrain|subdue|\bke\b|克|преодолева|подавля|разруша|побежда|(?<!\p{L})бь[её]т|сдержива|контролиру|покоря|уничтожа/iu;
const KE_PASSIVE = /(?:overcome|destroyed|controlled|conquered|defeated|beaten|restrained|subdued)\s+by|loses?\s+to|weak\s+against|преодолева[её]тся|подавля[её]тся|разруша[её]тся|побежда[её]тся|сдержива[её]тся|контролиру[её]тся|проигрыва[её]т|уступа[её]т|слабее/iu;

// 'generation' | 'overcoming' | null, and whether the phrasing is passive.
export function relationOf(text) {
	const gp = GEN_PASSIVE.test(text);
	const kp = KE_PASSIVE.test(text);
	const g = gp || GEN_ACTIVE.test(text);
	const k = kp || KE_ACTIVE.test(text);
	if (g === k) return null;
	return g ? { rel: "generation", passive: gp } : { rel: "overcoming", passive: kp };
}

function addChain(edges, rel, passive, els, where) {
	for (let i = 1; i < els.length; i++) {
		const a = els[i - 1].el;
		const b = els[i].el;
		if (a === b) continue;
		edges.push({ rel, from: passive ? b : a, to: passive ? a : b, where });
	}
}

// Edges from a table given as rows of cell texts (first row = header).
export function tableEdges(rows) {
	const edges = [];
	if (!rows?.length) return edges;
	const header = rows[0];
	const cols = header.map((h) => (elementsIn(h).length ? null : relationOf(h)));
	if (cols.some(Boolean)) {
		for (const row of rows.slice(1)) {
			const own = elementsIn(row[0] ?? "");
			if (new Set(own.map((x) => x.el)).size !== 1) continue;
			cols.forEach((c, j) => {
				if (!c || j === 0) return;
				const t = [...new Set(elementsIn(row[j] ?? "").map((x) => x.el))];
				if (t.length !== 1 || t[0] === own[0].el) return;
				edges.push({ rel: c.rel, from: c.passive ? t[0] : own[0].el, to: c.passive ? own[0].el : t[0], where: row.join(" | ") });
			});
		}
		return edges;
	}
	for (const row of rows) edges.push(...textEdges(row.join(" ")));
	return edges;
}

// Edges from free text (page innerText or command output).
export function textEdges(text) {
	const edges = [];
	let context = null;
	let since = 99;
	for (const line of text.split(/\r?\n/)) {
		since++;
		const parts = line.split(/(?<=[.;!?])\s+|\t/).filter((s) => s.trim());
		let lineHadEls = false;
		for (const seg of parts) {
			const els = elementsIn(seg);
			const r = relationOf(seg);
			if (els.length) lineHadEls = true;
			if (r && els.length >= 2) addChain(edges, r.rel, r.passive, els, seg.trim());
			else if (!r && els.length >= 2 && context && since <= 3 && /→|->|⟶|➜|>|—|-/.test(seg)) addChain(edges, context.rel, false, els, `${seg.trim()}  [under "${context.line}"]`);
		}
		const r = relationOf(line);
		if (r && !lineHadEls) {
			context = { ...r, line: line.trim().slice(0, 80) };
			since = 0;
		}
	}
	return edges;
}

// Judges sources: [{ name, edges, text }]. Returns { verdict, why, claims }.
export function judgeRules(sources) {
	const claims = [];
	for (const s of sources) {
		for (const rel of Object.keys(CANON)) {
			const es = s.edges.filter((e) => e.rel === rel);
			const pairs = [...new Set(es.map((e) => `${e.from}>${e.to}`))];
			if (pairs.length < 4) continue;
			const canon = Object.entries(CANON[rel]).map(([a, b]) => `${a}>${b}`);
			const wrong = pairs.filter((p) => !canon.includes(p));
			const missing = canon.filter((p) => !pairs.includes(p));
			claims.push({
				source: s.name,
				rel,
				right: !wrong.length && !missing.length,
				wrong,
				missing,
				evidence: [...new Set(es.map((e) => e.where))].slice(0, 12),
			});
		}
	}
	const bad = claims.filter((c) => !c.right);
	if (bad.length) {
		return {
			verdict: "FAIL",
			why: bad.map((c) => `${c.source}: ${c.rel} differs from the canon (wrong: ${c.wrong.join(", ") || "none"}; missing: ${c.missing.join(", ") || "none"})`).join("; "),
			claims,
		};
	}
	const ok = Object.keys(CANON).filter((rel) => claims.some((c) => c.rel === rel && c.right));
	if (ok.length === 2) return { verdict: "PASS", why: "both cycles found and match the canon", claims, page: claims.find((c) => c.right).source };
	return { verdict: "OPERATOR", why: ok.length ? `only the ${ok[0]} cycle was recognised; the other is not parsed` : "no rules table the checker can parse", claims };
}

// Scoring description on the page that holds the rules: a sentence that names
// an outcome (points, round, win, draw) and either a relation or a cycle.
const SCORE = /очк|балл|\bpoints?\b|\bscor|сч[её]т|раунд|\brounds?\b|выигр|побед|\bwins?\b|ничь|\bdraw\b|\btie\b/iu;
const CYCLE = /цикл|cycle|стихи|element/iu;
export function scoringSentence(text) {
	for (const s of text.split(/(?<=[.!?])\s+|\r?\n/)) {
		if (SCORE.test(s) && (relationOf(s) || GEN_ACTIVE.test(s) || KE_ACTIVE.test(s) || CYCLE.test(s)) && s.length > 20) return s.trim();
	}
	return null;
}
