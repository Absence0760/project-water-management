// The pure quantile mapper (./quantileMap.ts, engine ≥ 1.20.0, issue #66).
import { describe, expect, it } from 'vitest';
import { heavyDayShare, mapWetDay, QUANTILE_POINTS, quantileMapValue, quantileTable, rescaleToTotal } from './quantileMap';

describe('quantileTable', () => {
	it('reads percentiles from the sorted sample by linear interpolation, min and max included', () => {
		const t = quantileTable([5, 1, 3, 2, 4])!;
		expect(t).toHaveLength(QUANTILE_POINTS);
		expect(t[0]).toBe(1);
		expect(t[100]).toBe(5);
		expect(t[50]).toBe(3);
		expect(t[25]).toBe(2);
		expect(t[10]).toBeCloseTo(1.4, 12);
		// Non-decreasing.
		for (let k = 1; k < t.length; k++) expect(t[k]!).toBeGreaterThanOrEqual(t[k - 1]!);
	});

	it('is null for an empty sample and leaves non-finite values out', () => {
		expect(quantileTable([])).toBeNull();
		expect(quantileTable([Number.NaN, Infinity])).toBeNull();
		expect(quantileTable([2, Number.NaN])!.every((x) => x === 2)).toBe(true);
	});
});

describe('quantileMapValue', () => {
	const src = quantileTable([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;

	it('is the identity when source and target are the same distribution', () => {
		for (const x of [1, 1.5, 3.3, 7, 10]) expect(quantileMapValue(src, src, x)).toBeCloseTo(x, 12);
	});

	it('maps each quantile onto the target’s, and clamps outside the source to the target’s ends', () => {
		const tgt = quantileTable([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])!;
		expect(quantileMapValue(src, tgt, 5)).toBeCloseTo(10, 12);
		expect(quantileMapValue(src, tgt, 0.2)).toBe(2);
		expect(quantileMapValue(src, tgt, 99)).toBe(20);
	});

	it('is monotone non-decreasing in x', () => {
		const tgt = quantileTable([1, 1, 1, 2, 5, 9, 30, 31, 60])!;
		let prev = -Infinity;
		for (let x = 0; x <= 12; x += 0.05) {
			const y = quantileMapValue(src, tgt, x);
			expect(y).toBeGreaterThanOrEqual(prev);
			prev = y;
		}
	});

	it('maps a tie to the middle of its flat run', () => {
		const ties = quantileTable([1, 1, 1, 1, 5])!; // 1 up to the 75th percentile
		const tgt = quantileTable(Array.from({ length: 101 }, (_, i) => i))!; // value = percentile
		expect(quantileMapValue(ties, tgt, 1)).toBeCloseTo(37.5, 9);
	});

	it('refuses tables of different lengths', () => {
		expect(() => quantileMapValue([1, 2], [1, 2, 3], 1)).toThrow(RangeError);
	});
});

describe('mapWetDay and rescaleToTotal', () => {
	it('leaves a dry day (below the threshold) as it is', () => {
		const a = quantileTable([1, 2, 3])!;
		const b = quantileTable([10, 20, 30])!;
		expect(mapWetDay(a, b, 0.4, 1)).toBe(0.4);
		expect(mapWetDay(a, b, 2, 1)).toBeCloseTo(20, 12);
	});

	it('keeps the block total, and keeps the unmapped values when the mapped total is 0', () => {
		const r = rescaleToTotal([1, 3, 6], [2, 2, 2], 6);
		expect(r.values.reduce((s, x) => s + x, 0)).toBeCloseTo(6, 12);
		expect(r.values[2]! / r.values[0]!).toBeCloseTo(6, 12);
		expect(r.kept).toBe(false);
		expect(rescaleToTotal([0, 0], [1, 2], 3)).toEqual({ values: [1, 2], kept: true });
		expect(rescaleToTotal([0, 0], [0, 0], 0)).toEqual({ values: [0, 0], kept: false });
	});
});

describe('heavyDayShare', () => {
	it('is the share of rain on days of at least the threshold', () => {
		expect(heavyDayShare([10, 20, 30, 0, -1], 20)).toEqual({ share: 50 / 60, totalMm: 60, heavyTotalMm: 50, heavyDays: 2 });
		expect(heavyDayShare([0, 0], 20).share).toBeNull();
	});
});
