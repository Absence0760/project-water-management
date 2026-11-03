// WR2012's monthly evaporation for a catchment (wr2012Evaporation.ts; docs/maps.md
// § WR2012 evaporation by quaternary): the area shares of the quaternaries a
// boundary overlaps, the area-weighted rows and the revision's wording.
// Invented numbers only.
import { describe, expect, it } from 'vitest';
import type { Geometry } from './geojson.js';
import { areaWeighted, quaternariesText, quaternaryShares, type EvaporationQuaternary } from './wr2012Evaporation.js';

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
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const ROW = [190, 229, 260, 267, 216, 190, 127, 89, 70, 70, 95, 140];

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

describe('areaWeighted', () => {
	it('with one quaternary is just its row', () => {
		expect(areaWeighted([{ share: 1, row: ROW }])).toEqual(ROW);
	});

	it('weights each quaternary’s months by its share, ignoring rows without one (they don’t dilute it)', () => {
		const other = ROW.map((v) => v + 40);
		const rows = [
			{ share: 0.75, row: ROW },
			{ share: 0.25, row: other },
			{ share: 0.2, row: null }
		];
		const got = areaWeighted(rows)!;
		expect(got[0]).toBeCloseTo(Math.round((0.75 * 190 + 0.25 * 230) * 10) / 10, 9);
		expect(sum(got)).toBeCloseTo(sum(ROW) + 0.25 * 480, 0);
		expect(areaWeighted(rows.slice(0, 2))).toEqual(got);
	});

	it('is null when no row has one', () => {
		expect(areaWeighted([{ share: 1, row: null }])).toBeNull();
		expect(areaWeighted([])).toBeNull();
	});
});

describe('quaternariesText', () => {
	const q = (code: string, share: number, apan: { modules: number; agree: number } | null): EvaporationQuaternary => ({
		code,
		dataset: 'synthetic',
		evaporationDataset: 'synthetic',
		synthetic: true,
		share,
		areaKm2: 1,
		zone: null,
		maeMm: null,
		spanMm: ROW,
		apanMm: apan ? ROW : null,
		span: { modules: 1, agree: 1, othersMm: [] },
		apan: apan ? { ...apan, othersMm: [] } : null,
		files: 2,
		disagree: !!apan && apan.agree < apan.modules,
		why: apan ? null : 'no irrigation module gives its A-pan, only S-pan',
		source: 's'
	});

	it('names each quaternary with A-pan, largest share first, and where its irrigation modules disagree', () => {
		expect(quaternariesText([q('Z01A', 0.25, { modules: 1, agree: 1 }), q('Z01B', 0.6, { modules: 3, agree: 2 }), q('Z02C', 0.15, null)])).toBe(
			'Z01B 60 % (2 of 3 irrigation modules agree), Z01A 25 %'
		);
	});

	it('counts the rest past the most it names', () => {
		const many = Array.from({ length: 10 }, (_, i) => q(`Z0${i}A`, 0.1, { modules: 1, agree: 1 }));
		expect(quaternariesText(many, 3)).toMatch(/^Z00A 10 %, Z01A 10 %, Z02A 10 % and 7 more$/);
	});
});
