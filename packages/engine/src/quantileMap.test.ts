// The pure quantile mapper (./quantileMap.ts, engine ≥ 1.21.0, issue #66).
import { describe, expect, it } from 'vitest';
import { fitMonthlyTables, heavyDayShare, mapBlockDryBelow, mapBlockToTotal, mapWetDay, quantileMapBasisText, QUANTILE_POINTS, quantileMapValue, quantileTable, rescaleToTotal } from './quantileMap';

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

describe('fitMonthlyTables (engine ≥ 1.53.0, shared by rain-source periods and the CHIRPS gap map)', () => {
	const byMonth = (f: (m: number) => number[]) => Array.from({ length: 13 }, (_, m) => (m === 0 ? [] : f(m)));
	const wet = (n: number, scale = 1) => Array.from({ length: n }, (_, i) => (i + 1) * scale);

	it('maps a month on its own wet days, else on its season, else not at all', () => {
		// 40 wet days a month except the winter (JJA: 5 each) and September (10, with Oct and Nov: SON 90).
		const n = (m: number) => ([6, 7, 8].includes(m) ? 5 : m === 9 ? 10 : 40);
		const f = fitMonthlyTables(byMonth((m) => wet(n(m))), byMonth((m) => wet(n(m), 2)), 30);
		expect(f.months.map((x) => x.basis)).toEqual(['month', 'month', 'month', 'month', 'month', null, null, null, 'season', 'month', 'month', 'month']);
		expect(f.months[8]).toEqual({ month: 9, basis: 'season', targetN: 90, sourceN: 90 });
		expect(f.months[6]).toEqual({ month: 7, basis: null, targetN: 5, sourceN: 5 });
		expect(f.tables[6]).toBeNull();
		expect(quantileMapValue(f.tables[0]!.source, f.tables[0]!.target, 80)).toBe(40);
		expect(quantileMapBasisText(f.months)).toBe(
			'by month: Oct, Nov, Dec, Jan, Feb, Mar, Apr, May; by season: Sep; not mapped (fewer than 30 wet days even over the season): Jun, Jul, Aug'
		);
	});

	it('with matchFrequency, raises the source threshold until its wet-day rate is the target’s', () => {
		// 100 paired days: the target wet on 40 (≥ 1 mm), the source on 80, drizzle on the extra 40.
		const target = byMonth(() => [...wet(40, 0.5).map((x) => x + 1), ...new Array(60).fill(0)]);
		const source = byMonth(() => [...wet(40).map((x) => x + 5), ...new Array(40).fill(1.5), ...new Array(20).fill(0)]);
		const f = fitMonthlyTables(target, source, 30, { wetDayMm: 1, matchFrequency: true });
		expect(f.months[0]).toEqual({ month: 1, basis: 'month', targetN: 40, sourceN: 40, sourceWetMm: 6 });
		// A source drier than the target keeps the wet-day threshold.
		const g = fitMonthlyTables(source, target, 30, { wetDayMm: 1, matchFrequency: true });
		expect(g.months[0]!.sourceWetMm).toBe(1);
		expect(g.months[0]!.sourceN).toBe(40);
	});
});

describe('mapBlockDryBelow (the CHIRPS gap map)', () => {
	const table = { source: quantileTable([2, 4, 6, 8])!, target: quantileTable([1, 5, 10, 20])! };

	it('drys the days below the threshold, maps the rest and keeps the block total', () => {
		const r = mapBlockDryBelow([0, 1, 1.5, 2, 8], table, 2);
		expect(r.kept).toBe(false);
		expect(r.values.slice(0, 3)).toEqual([0, 0, 0]);
		expect(r.values.reduce((s, x) => s + x, 0)).toBeCloseTo(12.5, 12);
		expect(r.values[4]! / r.values[3]!).toBeCloseTo(20 / 1, 12);
	});

	it('keeps a block with rain but no day at the threshold, and a dry block dry', () => {
		expect(mapBlockDryBelow([0.5, 1], table, 2)).toEqual({ values: [0.5, 1], kept: true });
		expect(mapBlockDryBelow([0, 0], table, 2)).toEqual({ values: [0, 0], kept: false });
	});

	it('mapBlockToTotal (a rain-source period) maps wet values only, total kept', () => {
		const r = mapBlockToTotal([2, 8], table, 1);
		expect(r.values.reduce((s, x) => s + x, 0)).toBeCloseTo(10, 12);
	});
});
