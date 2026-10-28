// The regional GR4J prior (issue #622, docs/model.md §2.10m): hand-computed
// cases for the weighting and the quantiles, an empty donor set, k past the
// donors, the leave-one-out score, the soil x1 relation used and dropped, and
// the penalty and box calibration will read.
import { describe, expect, it } from 'vitest';
import * as engine from '../index';
import {
	attributeScales,
	DEFAULT_PRIOR_K,
	donorSetHash,
	greatCircleKm,
	priorBox,
	priorLeaveOneOut,
	priorPenalty,
	regionalPrior,
	scaleOf,
	similarityDistance,
	soilX1At,
	soilX1Relation,
	weightedQuantile,
	Z90,
	type CatchmentAttributes,
	type Gr4jDonor
} from './prior';

const NONE: CatchmentAttributes = { aridity: null, mapMm: null, slopeDeg: null, clayPct: null, sandPct: null, forestPct: null, areaKm2: null };
const attrs = (over: Partial<CatchmentAttributes>): CatchmentAttributes => ({ ...NONE, ...over });
const donor = (id: string, lon: number, lat: number, x1: number, over: Partial<Gr4jDonor> = {}): Gr4jDonor => ({
	id,
	lon,
	lat,
	attributes: NONE,
	params: { x1, x2: 0, x3: 90, x4: 1.7 },
	...over
});

describe('weightedQuantile', () => {
	it('is Hazen’s with equal weights, flat past the end positions', () => {
		// Positions 0.125, 0.375, 0.625, 0.875.
		expect(weightedQuantile([3, 1, 4, 2], [1, 1, 1, 1], 0.5)).toBeCloseTo(2.5, 12);
		expect(weightedQuantile([3, 1, 4, 2], [1, 1, 1, 1], 0.1)).toBe(1);
		expect(weightedQuantile([3, 1, 4, 2], [1, 1, 1, 1], 0.9)).toBe(4);
		expect(weightedQuantile([3, 1, 4, 2], [1, 1, 1, 1], 0.25)).toBeCloseTo(1.5, 12);
	});

	it('moves toward the heavier donor, linearly or in log space', () => {
		// Weights 0.75 and 0.25: positions 0.375 and 0.875, so p50 is a quarter of the way.
		expect(weightedQuantile([10, 20], [3, 1], 0.5)).toBeCloseTo(12.5, 12);
		expect(weightedQuantile([10, 20], [3, 1], 0.5, true)).toBeCloseTo(10 * 2 ** 0.25, 12);
	});
});

describe('similarity and distance', () => {
	it('standardises each attribute over the donors and takes the RMS of the z differences', () => {
		const ds = [0, 1, 2].map((a) => ({ attributes: attrs({ aridity: a, mapMm: 500 }) }));
		const s = attributeScales(ds);
		// mapMm has no spread: left out.
		expect(s.mapMm).toBeUndefined();
		expect(s.aridity!.mean).toBe(1);
		expect(s.aridity!.sd).toBeCloseTo(Math.sqrt(2 / 3), 12);
		expect(similarityDistance(attrs({ aridity: 0 }), ds[2]!.attributes, s)).toBeCloseTo(2 / Math.sqrt(2 / 3), 12);
		expect(similarityDistance(NONE, ds[2]!.attributes, s)).toBeNull();
	});

	it('compares area in log space', () => {
		const ds = [10, 100, 1000].map((a) => ({ attributes: attrs({ areaKm2: a }) }));
		const s = attributeScales(ds);
		expect(s.areaKm2!.mean).toBeCloseTo(Math.log(100), 12);
		expect(similarityDistance(attrs({ areaKm2: 100 }), attrs({ areaKm2: 1000 }), s)).toBeCloseTo(Math.log(10) / s.areaKm2!.sd, 12);
	});

	it('measures great-circle km (one degree of a meridian ≈ 111.2 km)', () => {
		expect(greatCircleKm(20, -30, 20, -31)).toBeCloseTo(111.195, 2);
		expect(greatCircleKm(20, -30, 20, -32)).toBeCloseTo(2 * greatCircleKm(20, -30, 20, -31), 9);
	});
});

describe('regionalPrior', () => {
	it('weights the kept donors by inverse dissimilarity and takes their weighted quantiles (hand-computed)', () => {
		// All at the target's outlet (no distance), similarity only. Aridity 0, 1, 2 (sd √(2/3)); target 0.5:
		// d_s = 0.612, 0.612, 1.837, median 0.612, so D = 1, 1, 3 and the weights 3/7, 3/7, 1/7.
		const ds = [donor('a', 20, -30, 100, { attributes: attrs({ aridity: 0 }) }), donor('b', 20, -30, 200, { attributes: attrs({ aridity: 1 }) }), donor('c', 20, -30, 400, { attributes: attrs({ aridity: 2 }) })];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: attrs({ aridity: 0.5 }) }, ds, { k: 3, similarityWeight: 1, leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		expect(p.donors.map((d) => d.id)).toEqual(['a', 'b', 'c']);
		expect(p.donors.map((d) => d.dissimilarity)).toEqual([expect.closeTo(1, 12), expect.closeTo(1, 12), expect.closeTo(3, 12)]);
		expect(p.donors.map((d) => d.weight)).toEqual([expect.closeTo(3 / 7, 12), expect.closeTo(3 / 7, 12), expect.closeTo(1 / 7, 12)]);
		// Positions 3/14, 9/14, 13/14; in log space p50 is 2/3 of the way from 100 to 200, p90 9/10 of the way from 200 to 400.
		expect(p.params.x1.p10).toBeCloseTo(100, 9);
		expect(p.params.x1.p50).toBeCloseTo(100 * 2 ** (2 / 3), 9);
		expect(p.params.x1.p90).toBeCloseTo(200 * 2 ** 0.9, 9);
		// The parameters every donor shares come back as they are.
		expect(p.params.x3).toEqual({ p10: expect.closeTo(90, 9), p50: expect.closeTo(90, 9), p90: expect.closeTo(90, 9) });
		expect(p.params.x2).toEqual({ p10: 0, p50: 0, p90: 0 });
		expect(p.leaveOneOut).toBeNull();
		expect(p.donorSetHash).toBe(donorSetHash(ds));
	});

	it('on distance alone, weights are inversely proportional to distance', () => {
		const ds = [donor('n1', 20, -31, 100), donor('n2', 20, -32, 200), donor('n4', 20, -34, 400)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { similarityWeight: 0, leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		const w = Object.fromEntries(p.donors.map((d) => [d.id, d.weight]));
		expect(w.n1! / w.n2!).toBeCloseTo(2, 9);
		expect(w.n1! / w.n4!).toBeCloseTo(4, 9);
		expect(p.donors[0]!.distanceKm).toBeCloseTo(greatCircleKm(20, -30, 20, -31), 9);
	});

	it('keeps similarity in play when most donors tie the target exactly (the median d_s is 0)', () => {
		// Three wet donors match the target's aridity exactly but lie 100–200 km off; two dry ones lie 1–2 km off.
		const ds = [
			donor('w1', 20, -30.9, 200, { attributes: attrs({ aridity: 0.5 }) }),
			donor('w2', 20, -31.4, 210, { attributes: attrs({ aridity: 0.5 }) }),
			donor('w3', 20, -31.8, 220, { attributes: attrs({ aridity: 0.5 }) }),
			donor('d1', 20, -30.009, 1100, { attributes: attrs({ aridity: 0.1 }) }),
			donor('d2', 20, -30.018, 1150, { attributes: attrs({ aridity: 0.1 }) })
		];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: attrs({ aridity: 0.5 }) }, ds, { k: 3, similarityWeight: 0.9, leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		// d_s's median is 0, so it is scaled by the mean of the positive ones and the matching donors win.
		expect(p.donors.map((d) => d.id).sort()).toEqual(['w1', 'w2', 'w3']);
		expect(p.params.x1.p50).toBeLessThan(250);
		expect(scaleOf([0, 0, 0, 2, 4])).toBe(3);
		expect(scaleOf([0, 0])).toBe(0);
		expect(scaleOf([1, 2, 3])).toBe(2);
	});

	it('takes only the first donor of a repeated id', () => {
		const ds = [donor('a', 20, -31, 100), donor('a', 20, -31.5, 900), donor('b', 20, -32, 200)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		expect(p.k).toBe(2);
		expect(p.params.x1.p90).toBeLessThanOrEqual(200);
	});

	it('keeps the k nearest and ranks ties by id', () => {
		const ds = [donor('z', 20, -31, 100), donor('y', 20, -29, 200), donor('far', 20, -40, 400)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { k: 2, leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		expect(p.donors.map((d) => d.id)).toEqual(['y', 'z']);
		expect(p.k).toBe(2);
		expect(p.donorCount).toBe(3);
	});

	it('keeps every donor when k is past them', () => {
		const ds = [donor('a', 20, -31, 100), donor('b', 20, -32, 200)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { k: 50 });
		if (!p.ok) throw new Error(p.reason);
		expect(p.k).toBe(2);
		expect(p.donors).toHaveLength(2);
		// Two donors: too few to score by leave-one-out.
		expect(p.leaveOneOut).toBeNull();
	});

	it('says why for an empty donor set, or one with no usable donor', () => {
		expect(regionalPrior({ lon: 20, lat: -30, attributes: NONE }, [])).toEqual({ ok: false, reason: 'no donor basins are loaded', donorCount: 0, donorSetHash: donorSetHash([]) });
		const bad = [donor('a', 20, -31, 0)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, bad);
		expect(p).toMatchObject({ ok: false, reason: 'no donor has a full, valid parameter set', donorCount: 1, donorSetHash: donorSetHash([]) });
	});

	it('leaves an invalid donor out and refuses a bad k or weight', () => {
		const ds = [donor('a', 20, -31, 100), donor('bad', 20, -31, Number.NaN), donor('b', 20, -32, 200)];
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { leaveOneOut: false });
		if (!p.ok) throw new Error(p.reason);
		expect(p.donors.map((d) => d.id).sort()).toEqual(['a', 'b']);
		expect(p.k).toBe(2);
		expect(p.donorSetHash).toBe(donorSetHash([ds[0]!, ds[2]!]));
		expect(() => regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { k: 0 })).toThrow(RangeError);
		expect(() => regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds, { similarityWeight: 1.5 })).toThrow(RangeError);
	});

	it('defaults to k = 7 and an even mix', () => {
		const ds = Array.from({ length: 10 }, (_, i) => donor(`d${i}`, 20, -31 - i, 100 + 10 * i));
		const p = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds);
		if (!p.ok) throw new Error(p.reason);
		expect(DEFAULT_PRIOR_K).toBe(7);
		expect(p.k).toBe(7);
		expect(p.similarityWeight).toBe(0.5);
		expect(p.leaveOneOut?.n).toBe(10);
	});
});

describe('the leave-one-out score', () => {
	// Four donors down a meridian, x1 doubling each degree; distance only, two donors kept.
	const line = [donor('d0', 20, -30, 100), donor('d1', 20, -31, 200), donor('d2', 20, -32, 400), donor('d3', 20, -33, 800)];

	it('scores each held-out donor against the plain median of the others (hand-computed)', () => {
		const loo = priorLeaveOneOut(line, 2, 0.5)!;
		expect(loo.n).toBe(4);
		// x2, x3 and x4 are the same for every donor: nothing to score.
		expect(Object.keys(loo.params)).toEqual(['x1']);
		// Inner donors: their two neighbours at equal weight, p50 their log-mid, exact. End donors: neighbours at 1 and 2
		// degrees (weights 2/3, 1/3), p50 off by (4/3) ln 2. The median of the others is off by 2 ln 2 at the ends, ln 2 inside.
		const se = 2 * ((4 / 3) * Math.LN2) ** 2;
		const seNull = 2 * (2 * Math.LN2) ** 2 + 2 * Math.LN2 ** 2;
		expect(loo.params.x1!.rmse).toBeCloseTo(Math.sqrt(se / 4), 9);
		expect(loo.params.x1!.skill).toBeCloseTo(1 - se / seNull, 9);
		expect(loo.params.x1!.coverage).toBe(0.5);
		expect(loo.skill).toBeCloseTo(1 - se / seNull, 9);
	});

	it('is what regionalPrior reports, and null under three donors', () => {
		const p = regionalPrior({ lon: 20, lat: -29, attributes: NONE }, line, { k: 2 });
		if (!p.ok) throw new Error(p.reason);
		expect(p.leaveOneOut).toEqual(priorLeaveOneOut(line, 2, 0.5));
		expect(priorLeaveOneOut(line.slice(0, 2), 2, 0.5)).toBeNull();
	});

	it('has no skill to report when the median is exact for every donor', () => {
		const same = [donor('a', 20, -30, 100), donor('b', 20, -31, 100), donor('c', 20, -32, 100)];
		// x1 doesn't vary, so no parameter is scored.
		expect(priorLeaveOneOut(same, 2, 0.5)).toEqual({ n: 3, params: {}, skill: null });
	});
});

describe('the soil x1 relation', () => {
	const soil = (pawc: number[], x1: number[]) => pawc.map((p, i) => donor(`s${i}`, 20, -30 - i, x1[i]!, { pawcMm: p }));

	it('fits ln x1 on ln PAWC and is used when it has skill', () => {
		const rel = soilX1Relation(soil([50, 100, 150, 200, 300], [100, 200, 300, 400, 600]));
		if (rel.status !== 'used') throw new Error(rel.reason);
		expect(rel.n).toBe(5);
		expect(rel.slope).toBeCloseTo(1, 12);
		expect(rel.intercept).toBeCloseTo(Math.LN2, 12);
		expect(rel.residualSd).toBeCloseTo(0, 9);
		expect(rel.looR2).toBeCloseTo(1, 12);
		expect(soilX1At(rel, 150)).toEqual({ p10: expect.closeTo(300, 6), p50: expect.closeTo(300, 9), p90: expect.closeTo(300, 6) });
	});

	it('spreads x1 by the residual sd', () => {
		// ln x1 = ln PAWC + (+e, −e, +e, −e, …): slope near 1, the spread from the residuals.
		const pawc = [50, 80, 120, 160, 220, 300];
		const e = 0.1;
		const rel = soilX1Relation(soil(pawc, pawc.map((p, i) => p * Math.exp(i % 2 ? -e : e))));
		if (rel.status !== 'used') throw new Error(rel.reason);
		const r = soilX1At(rel, 100);
		expect(Math.log(r.p90 / r.p50)).toBeCloseTo(Z90 * rel.residualSd, 12);
		expect(Math.log(r.p50 / r.p10)).toBeCloseTo(Z90 * rel.residualSd, 12);
	});

	it('is dropped, with the reason, when it has no skill under leave-one-out', () => {
		const rel = soilX1Relation(soil([100, 200, 100, 200, 150], [100, 100, 200, 200, 140]));
		expect(rel.status).toBe('dropped');
		if (rel.status !== 'dropped') return;
		expect(rel.looR2).not.toBeNull();
		expect(rel.looR2!).toBeLessThan(0.2);
		expect(rel.reason).toMatch(/^no skill: the leave-one-out R² is -?\d\.\d\d, under 0.2$/);
	});

	it('is dropped with too few donors, or no spread in PAWC', () => {
		expect(soilX1Relation(soil([100, 200, 300], [100, 200, 300]))).toMatchObject({ status: 'dropped', n: 3, looR2: null });
		expect(soilX1Relation(soil([100, 100, 100, 100], [100, 200, 300, 400]))).toMatchObject({ status: 'dropped', n: 4, reason: expect.stringMatching(/doesn’t vary/) });
		// Donors without a PAWC don't count.
		expect(soilX1Relation([...soil([100, 200], [100, 200]), donor('x', 20, -40, 300), donor('y', 20, -41, 400)])).toMatchObject({ status: 'dropped', n: 2 });
	});

	it('is evaluated at the target’s PAWC by regionalPrior, and only then', () => {
		const ds = soil([50, 100, 150, 200, 300], [100, 200, 300, 400, 600]);
		const at = regionalPrior({ lon: 20, lat: -30, attributes: NONE, pawcMm: 250 }, ds);
		const none = regionalPrior({ lon: 20, lat: -30, attributes: NONE }, ds);
		if (!at.ok || !none.ok) throw new Error('no prior');
		expect(at.soil.status).toBe('used');
		expect(at.soilX1!.p50).toBeCloseTo(500, 6);
		expect(none.soilX1).toBeNull();
	});
});

describe('priorPenalty and priorBox', () => {
	const priors = {
		x1: { p10: 100, p50: 200, p90: 400 },
		x2: { p10: 0, p50: 0, p90: 0 },
		x3: { p10: 45, p50: 90, p90: 180 },
		x4: { p10: 1.2, p50: 1.7, p90: 2.4 }
	};

	it('is ½ Σ z² in log space, 0 at the p50s and ½ Z90² at a p10 or p90', () => {
		expect(priorPenalty(priors, { x1: 200, x2: 0, x3: 90, x4: 1.7 })).toBe(0);
		expect(priorPenalty(priors, { x1: 400 })).toBeCloseTo(0.5 * Z90 ** 2, 12);
		expect(priorPenalty(priors, { x1: 100 })).toBeCloseTo(0.5 * Z90 ** 2, 12);
		// Two parameters at their p90s add.
		expect(priorPenalty(priors, { x1: 400, x3: 180 })).toBeCloseTo(Z90 ** 2, 12);
		// x2 has no spread: it adds nothing, whatever its value.
		expect(priorPenalty(priors, { x2: 2 })).toBe(0);
		expect(priorPenalty(priors, { x1: 0 })).toBe(Infinity);
		expect(priorPenalty({}, { x1: 400 })).toBe(0);
	});

	it('spreads x2 linearly when it varies', () => {
		const p = { x2: { p10: -1, p50: 0, p90: 1 } };
		expect(priorPenalty(p, { x2: 1 })).toBeCloseTo(0.5 * Z90 ** 2, 12);
		expect(priorPenalty(p, { x2: -1 })).toBeCloseTo(0.5 * Z90 ** 2, 12);
	});

	it('is the p10–p90 box inside GR4J’s hard bounds', () => {
		expect(priorBox(priors)).toEqual({ x1: { min: 100, max: 400 }, x2: { min: 0, max: 0 }, x3: { min: 45, max: 180 }, x4: { min: 1.2, max: 2.4 } });
		const wide = { ...priors, x1: { p10: 5, p50: 200, p90: 5000 }, x4: { p10: 0.1, p50: 2, p90: 20 } };
		const box = priorBox(wide);
		expect(box.x1).toEqual({ min: 10, max: 3000 });
		expect(box.x4).toEqual({ min: 0.5, max: 10 });
	});
});

describe('the donor set’s hash', () => {
	const ds = [donor('a', 20, -31, 100), donor('b', 20, -32, 200)];
	it('ignores the order donors come in and changes with any value', () => {
		expect(donorSetHash([...ds].reverse())).toBe(donorSetHash(ds));
		expect(donorSetHash(ds)).toMatch(/^[0-9a-f]{16}$/);
		expect(donorSetHash([ds[0]!, { ...ds[1]!, params: { ...ds[1]!.params, x1: 201 } }])).not.toBe(donorSetHash(ds));
	});
});

it('is exported from the engine', () => {
	expect(engine.regionalPrior).toBe(regionalPrior);
	expect(engine.priorPenalty).toBe(priorPenalty);
});
