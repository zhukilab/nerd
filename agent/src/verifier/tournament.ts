// Probabilistic Pivot Tournament, ported from llm-as-a-verifier
// (llm_verifier/pivot_tournament.py, commit 8db8a11): best of N with
// N + k(N-k) + C(k,2) directed comparisons instead of N^2.
//
// 1. Ring pass: the N adjacent pairs of a random cycle; every candidate sits
//    once in slot A and once in slot B, so the verifier's slot bias cancels.
// 2. The top-k candidates of the ring pass become pivots.
// 3. Every non-pivot meets every pivot, and pivots meet each other.
// A comparison's rewards (Ra, Rb) become a soft win p = sigmoid(Ra - Rb).

export type DirectedScore = (a: number, b: number) => Promise<[number, number]>;

export function ringCycle(n: number, random: () => number): [number, number][] {
	if (n <= 1) return [];
	const perm = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[perm[i], perm[j]] = [perm[j], perm[i]];
	}
	return perm.map((p, t) => [p, perm[(t + 1) % n]]);
}

export function bradleyTerry(ra: number, rb: number): number {
	return 1 / (1 + Math.exp(-(ra - rb)));
}

export function pivotRoundPairs(n: number, pivots: number[]): [number, number][] {
	const set = new Set(pivots);
	const pairs: [number, number][] = [];
	for (let i = 0; i < n; i++) if (!set.has(i)) for (const p of pivots) pairs.push([i, p]);
	const sorted = [...pivots].sort((x, y) => x - y);
	for (let i = 0; i < sorted.length; i++)
		for (let j = i + 1; j < sorted.length; j++) pairs.push([sorted[i], sorted[j]]);
	return pairs;
}

export interface TournamentResult {
	best: number;
	meanPreference: number[];
	comparisons: [number, number, number, number][]; // a, b, Ra, Rb
}

export async function selectBest(
	n: number,
	score: DirectedScore,
	opts: { pivots?: number; random?: () => number } = {},
): Promise<TournamentResult> {
	const k = Math.min(opts.pivots ?? 2, n);
	const random = opts.random ?? Math.random;
	const w = new Array<number>(n).fill(0);
	const c = new Array<number>(n).fill(0);
	const comparisons: TournamentResult["comparisons"] = [];
	const play = async (pairs: [number, number][]) => {
		for (const [a, b] of pairs) {
			const [ra, rb] = await score(a, b); // one slot on the server: sequential
			comparisons.push([a, b, ra, rb]);
			const p = bradleyTerry(ra, rb);
			w[a] += p;
			c[a] += 1;
			w[b] += 1 - p;
			c[b] += 1;
		}
	};
	const mean = (i: number) => (c[i] ? w[i] / c[i] : 0);
	if (n <= 1) return { best: 0, meanPreference: [1], comparisons };

	const ring = ringCycle(n, random);
	// With two candidates the ring already holds both slot orders; pivot
	// rounds would only replay one of them.
	await play(ring);
	if (n > 2) {
		const pivots = Array.from({ length: n }, (_, i) => i)
			.sort((x, y) => mean(y) - mean(x) || x - y)
			.slice(0, k);
		await play(pivotRoundPairs(n, pivots));
	}
	const meanPreference = Array.from({ length: n }, (_, i) => mean(i));
	let best = 0;
	for (let i = 1; i < n; i++) if (meanPreference[i] > meanPreference[best]) best = i;
	return { best, meanPreference, comparisons };
}
