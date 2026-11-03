// WR2012's S-pan from a quaternary's MAE and its zone's monthly % (wr2012Span.ts;
// docs/model.md §2.3a, docs/maps.md § WR2012 S-pan): the rounding, the area
// shares of the quaternaries a boundary overlaps, and the area-weighted mean.
// Invented numbers only.
import { apanMonthlyFromSpan } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Geometry } from './geojson.js';
import { areaWeightedSpan, quaternariesText, quaternaryShares, spanFromMae, type SpanQuaternary } from './wr2012Span.js';

const box = (w: number, s: number, e: number, n: number): Geometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});
const Z1 = [10.2, 11.8, 13.0, 13.2, 11.0, 9.6, 6.6, 4.8, 3.6, 3.8, 5.2, 7.2];
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('spanFromMae', () => {
	it('is MAE × each month’s % ÷ 100, to 0.1 mm, so the months add up to the MAE when the % add up to 100 (within the rounding)', () => {
		const s = spanFromMae(1500, Z1);
		expect(s).toEqual([153, 177, 195, 198, 165, 144, 99, 72, 54, 57, 78, 108]);
		expect(sum(s)).toBeCloseTo(1500, 6);
		// Rounding each month to 0.1 mm moves the total by at most 12 × 0.05 mm.
		const odd = spanFromMae(1234.5, Z1);
		for (const v of odd) expect(Math.round(v * 10)).toBeCloseTo(v * 10, 9);
		expect(Math.abs(sum(odd) - 1234.5)).toBeLessThanOrEqual(0.6);
	});

	it('keeps a zone’s total off 100 % (WR2012’s rounded tables): a 98 % zone gives 98 % of MAE, within the rounding', () => {
		expect(Math.abs(sum(spanFromMae(1000, new Array(12).fill(98 / 12))) - 980)).toBeLessThanOrEqual(0.6);
	});
});

describe('quaternaryShares', () => {
	const Q = [
		{ code: 'Z01A', geometry: box(21, -33.75, 21.25, -33.5) },
		{ code: 'Z01B', geometry: box(21.25, -33.75, 21.5, -33.5) },
		{ code: 'Z02A', geometry: box(21, -34, 21.25, -33.75) }
	];

	it('gives a boundary inside one quaternary 100 % of it, and leaves out the ones it doesn’t reach', () => {
		const got = quaternaryShares(box(21.05, -33.7, 21.15, -33.6), Q);
		expect('shares' in got && got.shares).toEqual([{ code: 'Z01A', areaKm2: expect.any(Number), share: 1 }]);
	});

	it('splits a boundary across a divide by area, to within about one grid cell', () => {
		// 0.15° west of the Z01A/Z01B divide, 0.05° east of it: 75 % and 25 %.
		const got = quaternaryShares(box(21.1, -33.7, 21.3, -33.6), Q);
		if (!('shares' in got)) throw new Error(got.problem);
		expect(got.shares.map((s) => s.code)).toEqual(['Z01A', 'Z01B']);
		expect(got.shares[0]!.share).toBeCloseTo(0.75, 2);
		expect(got.shares[1]!.share).toBeCloseTo(0.25, 2);
		expect(sum(got.shares.map((s) => s.share))).toBeCloseTo(1, 9);
		expect(sum(got.shares.map((s) => s.areaKm2))).toBeCloseTo(got.boundaryKm2, 6);
	});

	it('leaves the part of a boundary in no quaternary out, so the shares add up to less than 1', () => {
		// Half of it east of Z01B, where no quaternary is loaded.
		const got = quaternaryShares(box(21.4, -33.7, 21.6, -33.6), Q);
		if (!('shares' in got)) throw new Error(got.problem);
		expect(got.shares.map((s) => s.code)).toEqual(['Z01B']);
		expect(got.shares[0]!.share).toBeCloseTo(0.5, 2);
	});

	it('handles a quaternary with a hole and a MultiPolygon one', () => {
		const ring = (w: number, so: number, e: number, n: number): [number, number][] => [
			[w, so],
			[e, so],
			[e, n],
			[w, n],
			[w, so]
		];
		const holed: Geometry = { type: 'Polygon', coordinates: [ring(21, -34, 22, -33), ring(21.4, -33.6, 21.6, -33.4)] };
		const multi: Geometry = { type: 'MultiPolygon', coordinates: [[ring(21.4, -33.6, 21.6, -33.4)]] };
		const got = quaternaryShares(box(21.3, -33.6, 21.6, -33.4), [
			{ code: 'Y01A', geometry: holed },
			{ code: 'Y01B', geometry: multi }
		]);
		if (!('shares' in got)) throw new Error(got.problem);
		expect(got.shares[0]).toMatchObject({ code: 'Y01A' });
		// To within one grid column (1/128 of the boundary's width) along each divide.
		expect(Math.abs(got.shares[0]!.share - 1 / 3)).toBeLessThan(1 / 128);
		expect(Math.abs(got.shares[1]!.share - 2 / 3)).toBeLessThan(1 / 128);
	});

	it('says why for a boundary that isn’t a polygon', () => {
		expect(quaternaryShares({ type: 'Point', coordinates: [21, -33] }, Q)).toEqual({ problem: 'the catchment boundary is not a polygon' });
	});
});

describe('areaWeightedSpan', () => {
	const Z2 = [9.8, 11.4, 12.6, 12.8, 10.8, 9.6, 7.0, 5.2, 4.0, 4.2, 5.4, 7.2];

	it('with one quaternary is just its row', () => {
		expect(areaWeightedSpan([{ share: 1, maeMm: 1500, pct: Z1 }])).toEqual(spanFromMae(1500, Z1));
	});

	it('weights each quaternary’s months by its share, from the unrounded values, ignoring rows without evaporation', () => {
		const rows = [
			{ share: 0.75, maeMm: 1500, pct: Z1 },
			{ share: 0.25, maeMm: 1600, pct: Z2 },
			{ share: 0.2, maeMm: null, pct: null }
		];
		const got = areaWeightedSpan(rows)!;
		const oct = (0.75 * 1500 * 10.2 + 0.25 * 1600 * 9.8) / 100;
		expect(got[0]).toBeCloseTo(Math.round(oct * 10) / 10, 9);
		// The annual total is the weighted mean of the MAEs (both zones add up to 100 %).
		expect(sum(got)).toBeCloseTo(0.75 * 1500 + 0.25 * 1600, 0);
		// The unshared part doesn't dilute it: the same with the row without evaporation left out.
		expect(areaWeightedSpan(rows.slice(0, 2))).toEqual(got);
	});

	it('is null when no row has evaporation', () => {
		expect(areaWeightedSpan([{ share: 1, maeMm: null, pct: null }])).toBeNull();
		expect(areaWeightedSpan([])).toBeNull();
	});

	it('converts to A-pan by the engine’s inverted equations, which refuse a month under their floor', () => {
		const span = spanFromMae(1500, Z1);
		const t = apanMonthlyFromSpan(span, 'taljaard2023');
		expect(t.ok && t.values[0]).toBeCloseTo((153 + 11.1745) / 0.8706, 1);
		// A low MAE puts winter under WR90's 32.5 mm a month.
		const low = apanMonthlyFromSpan(spanFromMae(800, Z1), 'wr90');
		expect(low.ok).toBe(false);
		expect(!low.ok && low.reason).toMatch(/S-pan in Jun, Jul is below 32\.5 mm/);
	});
});

describe('quaternariesText', () => {
	const q = (code: string, share: number, zone: string | null, maeMm: number | null): SpanQuaternary => ({
		code,
		dataset: 'synthetic',
		synthetic: true,
		share,
		areaKm2: 1,
		zone,
		maeMm,
		pct: zone ? Z1 : null,
		spanMm: zone ? [1] : null,
		source: 's'
	});

	it('names each quaternary with evaporation, largest share first, with its zone and MAE', () => {
		expect(quaternariesText([q('Z01A', 0.25, 'Z1', 1500), q('Z01B', 0.6, 'Z1', 1560.4), q('Z02A', 0.15, null, null)])).toBe('Z01B 60 % (zone Z1, MAE 1560 mm), Z01A 25 % (zone Z1, MAE 1500 mm)');
	});

	it('counts the rest past the most it names', () => {
		const many = Array.from({ length: 10 }, (_, i) => q(`Z0${i}A`, 0.1, 'Z1', 1500));
		expect(quaternariesText(many, 3)).toMatch(/^Z00A 10 % .*, Z02A 10 % \(zone Z1, MAE 1500 mm\) and 7 more$/);
	});
});
