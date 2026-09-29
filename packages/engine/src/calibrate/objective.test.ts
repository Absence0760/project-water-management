import { describe, expect, it } from 'vitest';
import { Rng } from '../random';
import { fdcSignatures, fitScores, inverseFlows, kgeLowHigh, kgeNp, kgePrime, kgeYearly, nse, objectiveLoss } from './objective';
import { OBJECTIVES } from './objectives';

const flows = (seed: number, n = 500) => {
	const rng = new Rng(seed);
	let q = 1;
	return Array.from({ length: n }, () => (q = rng.bool(0.08) ? q + rng.float(1, 40) : q * rng.float(0.85, 0.99)));
};

describe('objective scores', () => {
	it('a perfect fit scores 1 on every efficiency and 0 on every bias', () => {
		const o = flows(1);
		const years = o.map((_, i) => Math.floor(i / 100));
		const f = fitScores(o, o, years);
		for (const k of ['kgePrime', 'kgeYearly', 'kgeNp', 'nse', 'nseSqrt', 'nseLog', 'kgeLowHigh'] as const) expect(f[k], k).toBeCloseTo(1, 12);
		for (const k of ['volumeErrorPct', 'fdcHighPct', 'fdcMidSlopePct', 'fdcLowPct'] as const) expect(f[k], k).toBeCloseTo(0, 10);
		for (const id of OBJECTIVES) expect(objectiveLoss(id, o, o, years)).toBeCloseTo(0, 12);
	});

	it('KGE′ separates bias and variability: scaling flows by 1.2 leaves r and γ at 1, so KGE′ = 1 − 0.2', () => {
		const o = flows(2);
		expect(kgePrime(o, o.map((v) => v * 1.2))).toBeCloseTo(0.8, 12);
		// Adding a constant changes the mean (β) and the CV (γ) but not r.
		const mo = o.reduce((a, b) => a + b, 0) / o.length;
		const so = Math.sqrt(o.reduce((a, v) => a + (v - mo) ** 2, 0) / o.length);
		const beta = (mo + 1) / mo;
		const gamma = so / (mo + 1) / (so / mo);
		expect(kgePrime(o, o.map((v) => v + 1))).toBeCloseTo(1 - Math.sqrt((beta - 1) ** 2 + (gamma - 1) ** 2), 12);
	});

	it('the mean flow benchmark scores NSE 0 and KGE′ 1 − √2 (Knoben et al. 2019); flat observations can’t be scored', () => {
		const o = flows(3);
		const m = o.reduce((a, b) => a + b, 0) / o.length;
		expect(nse(o, o.map(() => m))).toBeCloseTo(0, 12);
		expect(kgePrime(o, o.map(() => m))).toBeCloseTo(1 - Math.SQRT2, 12);
		const flat = o.map(() => 2);
		expect(kgePrime(flat, o)).toBeNull();
		expect(nse(flat, o)).toBeNull();
		expect(objectiveLoss('kgePrime', flat, o)).toBe(Infinity);
	});

	it('non-parametric KGE ignores a monotone distortion of the timing (Spearman r stays 1)', () => {
		const o = flows(4);
		const s = o.map((v) => v ** 1.3);
		const scaled = s.map((v) => (v * o.reduce((a, b) => a + b, 0)) / s.reduce((a, b) => a + b, 0));
		// Same ranks and the same mean, so r = β = 1 and KGE-np = α = 1 − ½ Σ |FDC difference|.
		const n = o.length;
		const mean = o.reduce((a, b) => a + b, 0) / n;
		const so = [...o].sort((a, b) => a - b);
		const ss = [...scaled].sort((a, b) => a - b);
		const alpha = 1 - 0.5 * so.reduce((acc, v, i) => acc + Math.abs(ss[i]! / (n * mean) - v / (n * mean)), 0);
		expect(kgeNp(o, scaled)).toBeCloseTo(alpha, 10);
		expect(alpha).toBeLessThan(1);
	});

	it('FDC signatures: too-high peaks, a too-steep middle and too-low low flows each show with the right sign', () => {
		const o = flows(5, 1000);
		const peaks = o.map((v, i, a) => (v >= [...a].sort((x, y) => y - x)[19]! ? v * 1.5 : v));
		expect(fdcSignatures(o, peaks).fdcHighPct!).toBeGreaterThan(10);
		// Raising every flow to a power > 1 around its median steepens the FDC.
		const med = [...o].sort((a, b) => a - b)[500]!;
		expect(fdcSignatures(o, o.map((v) => med * (v / med) ** 1.5)).fdcMidSlopePct!).toBeGreaterThan(10);
		// %BiasFLV measures the shape of the low tail (log flows above the
		// minimum): a simulation whose low tail is flat has none of it, which
		// Yilmaz's −100·(sim − obs)/obs scores as +100 %.
		const lowCut = [...o].sort((a, b) => a - b)[320]!;
		const flat = o.map((v) => (v <= lowCut ? 0.5 : v));
		expect(fdcSignatures(o, flat).fdcLowPct).toBeCloseTo(100, 9);
	});

	it('year-balanced KGE′ weighs each water year once, whatever its flow or length', () => {
		// A wet year fitted perfectly and a dry year fitted badly: plain KGE′ is
		// dominated by the wet year, the year-balanced one is not.
		const wet = flows(6, 300).map((v) => v * 50);
		const dry = flows(7, 300);
		const o = [...wet, ...dry];
		const s = [...wet, ...dry.map((v) => v * 2)];
		const years = o.map((_, i) => (i < 300 ? 2001 : 2002));
		const k2 = kgePrime(dry, dry.map((v) => v * 2))!; // = 0: β = 2, r = γ = 1
		expect(kgeYearly(o, s, years)).toBeCloseTo((1 + k2) / 2, 12);
		expect(kgePrime(o, s)!).toBeGreaterThan(kgeYearly(o, s, years)!);
		// A year with fewer than 30 days is left out, and no scorable year gives null.
		expect(kgeYearly(o, s, o.map((_, i) => (i < 300 ? 2001 : i < 310 ? 2002 : 2003)))).toBeCloseTo((1 + kgePrime(dry.slice(10), dry.slice(10).map((v) => v * 2))!) / 2, 12);
		expect(kgeYearly([1, 2], [1, 2], [1, 2])).toBeNull();
		expect(() => objectiveLoss('kgeYearly', o, s)).toThrow(/water-year labels/);
	});

	it('gives null, not a number, when there is too little to score', () => {
		expect(fitScores([1], [1])).toMatchObject({ days: 1, kgePrime: null, nse: null, fdcHighPct: null });
		expect(fitScores([0, 0, 0], [1, 2, 3]).kgePrime).toBeNull();
	});
});

describe('KGE′(Q) + KGE′(1/Q) (CR-3)', () => {
	// KGE′ written out from its definition, independently of objective.ts.
	const kgeRef = (o: number[], s: number[]) => {
		const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
		const sd = (a: number[]) => Math.sqrt(m(a.map((v) => (v - m(a)) ** 2)));
		const r = m(o.map((v, i) => (v - m(o)) * (s[i]! - m(s)))) / (sd(o) * sd(s));
		return 1 - Math.hypot(r - 1, m(s) / m(o) - 1, sd(s) / m(s) / (sd(o) / m(o)) - 1);
	};

	it('is the mean of KGE′ on Q and on 1/(Q + ε), ε = 1 % of the mean observed flow, the same ε on both sides', () => {
		const o = flows(11, 400);
		const s = o.map((v, i) => v * (1 + 0.3 * Math.sin(i / 7)));
		const eps = o.reduce((a, b) => a + b, 0) / o.length / 100;
		const inv = (a: number[]) => a.map((q) => 1 / (q + eps));
		expect(kgeLowHigh(o, s)).toBeCloseTo((kgeRef(o, s) + kgeRef(inv(o), inv(s))) / 2, 12);
		expect(Array.from(inverseFlows([0, -1, 3], 0.5))).toEqual([2, 2, 1 / 3.5]);
		expect(objectiveLoss('kgeLowHigh', o, s)).toBeCloseTo(1 - kgeLowHigh(o, s)!, 14);
		expect(fitScores(o, s).kgeLowHigh).toBe(kgeLowHigh(o, s));
	});

	it('hand values with zero flows: ε keeps 1/Q finite, and a swapped pair scores −1 on both halves', () => {
		// o = [0, 2]: mean 1, ε = 0.01. Swapping the two days gives r = −1 with β = γ = 1,
		// on the flows and on 1/(Q + ε) alike, so each half is 1 − 2 = −1.
		expect(kgeLowHigh([0, 2], [2, 0])).toBeCloseTo(-1, 12);
		expect(kgeLowHigh([0, 2, 0, 5], [0, 2, 0, 5])).toBeCloseTo(1, 12);
		// A simulation that is dry every day has no mean to compare: no score.
		expect(kgeLowHigh([0, 2, 1], [0, 0, 0])).toBeNull();
		expect(objectiveLoss('kgeLowHigh', [0, 2, 1], [0, 0, 0])).toBe(Infinity);
	});

	it('does not depend on the flow unit (ε scales with the flows)', () => {
		const o = flows(12, 300);
		const s = o.map((v, i) => v * (i % 3 === 0 ? 0.7 : 1.1));
		const k = 86_400;
		expect(kgeLowHigh(o.map((v) => v * k), s.map((v) => v * k))).toBeCloseTo(kgeLowHigh(o, s)!, 10);
	});

	it('weights the low flows: tripling the lowest 20 % barely moves KGE′ but costs the low/high score', () => {
		const o = flows(13, 1000);
		const cut = [...o].sort((a, b) => a - b)[200]!;
		const s = o.map((v) => (v < cut ? v * 3 : v));
		const plain = kgePrime(o, s)!;
		expect(plain).toBeGreaterThan(0.9);
		expect(kgeLowHigh(o, s)!).toBeLessThan(plain - 0.1);
		// And the other way round: right on the low flows but 30 % high above them is judged on both halves.
		const peaks = o.map((v) => (v >= cut ? v * 1.3 : v));
		expect(kgeLowHigh(o, peaks)!).toBeGreaterThan(kgePrime(o, peaks)! + 0.05);
	});
});
