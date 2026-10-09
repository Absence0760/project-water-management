import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheOrigin } from './cellCacheStore.js';
import { type CacheView, CELL_VALUE_MAX_BITS, cellCentre, chcCell, decodeCellValue, encodeCellValue, planFetch, seriesFromCache, uniqueCells, viewKey } from './cellCache.js';
import { bboxCells } from './config.js';
import { FeedFormatError, FeedNoDataError } from './errors.js';
import { meanOf } from './sources/chirps.js';

/** A cache row for one cell and year: `days` maps an ISO day to its value (NaN = no data). */
function row(view: CacheView, cell: { row: number; col: number }, year: number, days: Record<string, number>, finalThrough = `${year}-12-31`) {
	const vals = new Array<number | null>(366).fill(null);
	for (const [day, v] of Object.entries(days)) vals[(Date.parse(day) - Date.parse(`${year}-01-01`)) / 86_400_000] = Math.fround(v);
	// Final on and before `finalThrough`, preliminary after it.
	const jan1 = Date.parse(`${year}-01-01`);
	view.set(viewKey(cell, year), { vals, final: vals.map((v, i) => v !== null && new Date(jan1 + i * 86_400_000).toISOString().slice(0, 10) <= finalThrough) });
	return view;
}

describe('the CHC grid', () => {
	it('names a cell by row from 60° N and column from 180° W, a point on an edge in the cell east / south of it', () => {
		expect(chcCell(59.975, -179.975)).toEqual({ row: 0, col: 0 });
		expect(chcCell(-20.025, 25.025)).toEqual({ row: 1600, col: 4100 });
		// On the edge between rows 1599 and 1600 (20° S) and columns 4099 and 4100 (25° E).
		expect(chcCell(-20, 25)).toEqual({ row: 1600, col: 4100 });
		// Float error in a coordinate drawn on the grid lines never moves the cell (−20.1 / 0.05 = −402.00000000000006).
		expect(chcCell(-20.1, 25.1)).toEqual({ row: 1602, col: 4102 });
		// The grid's own south-east corner, which config accepts.
		expect(chcCell(-60, 180)).toEqual({ row: 2399, col: 7199 });
		expect(() => chcCell(61, 0)).toThrow(/outside the CHIRPS grid/);
	});

	it('a cell’s centre names the same cell, over the whole grid', () => {
		for (let row = 0; row < 2400; row += 7) for (const col of [0, 1, 3599, 3600, 4100, 7198, 7199]) expect(chcCell(cellCentre({ row, col }).lat, cellCentre({ row, col }).lon)).toEqual({ row, col });
		expect(cellCentre({ row: 1600, col: 4100 })).toEqual({ lat: -20.025, lon: 25.025 });
	});

	it('a box’s cell centres are the cells it overlaps, each once, by row then column', () => {
		const cells = bboxCells({ south: -20.1, west: 25, north: -20, east: 25.1 });
		expect(uniqueCells(cells)).toEqual([
			{ row: 1600, col: 4100 },
			{ row: 1600, col: 4101 },
			{ row: 1601, col: 4100 },
			{ row: 1601, col: 4101 }
		]);
		// Two listed points in one cell are one cell to read.
		expect(uniqueCells([{ lat: -20.01, lon: 25.01 }, { lat: -20.04, lon: 25.04 }])).toEqual([{ row: 1600, col: 4100 }]);
	});
});

describe('a cell value in the fetcher’s answer', () => {
	it('is the float32’s bit pattern: the exact value the file held, in at most ten digits; no data as -1, an unread day as null', () => {
		const f32 = new Float32Array(1);
		const u32 = new Uint32Array(f32.buffer);
		let seed = 7;
		for (let i = 0; i < 20_000; i++) {
			seed = (seed * 1103515245 + 12345) >>> 0;
			// Any float32 from 0 to 2000 mm, the tiny ones too.
			u32[0] = seed % 0x44fa0000;
			const v = f32[0]!;
			const wire = JSON.parse(JSON.stringify(encodeCellValue(v))) as number;
			expect(decodeCellValue(wire)).toBe(v);
			expect(String(wire).length).toBeLessThanOrEqual(10);
			expect(wire).toBeLessThanOrEqual(CELL_VALUE_MAX_BITS);
		}
		// 2000 mm is the largest pattern the answer takes, and a pattern is ordered like its value.
		expect(decodeCellValue(CELL_VALUE_MAX_BITS)).toBe(2000);
		expect(encodeCellValue(Math.fround(2000.0001))).toBeGreaterThan(CELL_VALUE_MAX_BITS);
		// -0 (a value gridMean took as 0) travels as 0, never as a pattern the answer would refuse.
		expect(encodeCellValue(-0)).toBe(0);
		expect(encodeCellValue(Number.NaN)).toBe(-1);
		expect(decodeCellValue(-1)).toBeNaN();
		expect(encodeCellValue(null)).toBeNull();
		expect(decodeCellValue(null)).toBeNull();
	});
});

describe('planFetch', () => {
	const a = { row: 1600, col: 4100 };
	const b = { row: 1600, col: 4101 };
	const w = { start: '2026-01-01', end: '2026-01-04' };

	it('skips a day every cell holds final, reads only the final file of a day every cell holds, else reads it; only the cells not final', () => {
		const view = new Map();
		// a: final 1–3 January, preliminary on the 4th. b: final 1–2, nothing after.
		row(view, a, 2026, { '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3, '2026-01-04': 4 }, '2026-01-03');
		row(view, b, 2026, { '2026-01-01': 1, '2026-01-02': 2 });
		expect(planFetch([a, b], view, w)).toEqual({ cells: [a, b], plan: '1100' });
		// a alone: three final days, then one it holds only as preliminary.
		expect(planFetch([a], view, w)).toEqual({ cells: [a], plan: '1112' });
		// Positive control: nothing to read when every day is final.
		expect(planFetch([a], view, { start: '2026-01-01', end: '2026-01-03' })).toBeNull();
		// b is final on every day it reads: only a is fetched.
		expect(planFetch([a, b], view, { start: '2026-01-01', end: '2026-01-02' })).toBeNull();
		expect(planFetch([a, b], new Map(row(new Map(), b, 2026, { '2026-01-03': 1 })), { start: '2026-01-03', end: '2026-01-03' })).toEqual({ cells: [a], plan: '0' });
	});

	it('no data (the sea) is a value like any other: a final sea day is never read again', () => {
		const view = row(new Map(), a, 2026, { '2026-01-01': Number.NaN, '2026-01-02': Number.NaN });
		expect(planFetch([a], view, { start: '2026-01-01', end: '2026-01-02' })).toBeNull();
	});

	it('reads across a year end from each year’s row, and asks for nothing over an empty window', () => {
		const view = new Map();
		row(view, a, 2025, { '2025-12-31': 1 });
		row(view, a, 2026, { '2026-01-01': 1 }, '2025-12-31');
		expect(planFetch([a], view, { start: '2025-12-30', end: '2026-01-02' })).toEqual({ cells: [a], plan: '0120' });
		expect(planFetch([a], view, { start: '2026-02-01', end: '2026-01-31' })).toBeNull();
	});
});

describe('seriesFromCache', () => {
	const cells = [
		{ lat: -20.025, lon: 25.025, weight: 1 },
		{ lat: -20.025, lon: 25.075, weight: 3 }
	];
	const [a, b] = cells.map((c) => chcCell(c.lat, c.lon)) as [{ row: number; col: number }, { row: number; col: number }];
	const w = { start: '2026-01-01', end: '2026-01-05' };

	it('is gridMean’s weighted mean per day; a day a cell lacks is null, trailing ones dropped; preliminary where any cell is', () => {
		const view = new Map();
		row(view, a, 2026, { '2026-01-01': 1.1, '2026-01-02': 2, '2026-01-03': 3, '2026-01-04': 4 }, '2026-01-02');
		row(view, b, 2026, { '2026-01-01': 2.2, '2026-01-03': 5, '2026-01-04': 6 });
		const r = seriesFromCache(cells, view, w);
		// The same number gridMean gives for the same float32 values.
		expect(r.values[0]).toBe(meanOf([Math.fround(1.1), Math.fround(2.2)], cells));
		expect(r).toEqual({ startDate: '2026-01-01', values: [r.values[0], null, 4.5, 5.5], prelimDays: 2, finalThrough: '2026-01-01' });
	});

	it('refuses a listed cell over the sea, as reading it from the file did', () => {
		const view = new Map();
		row(view, a, 2026, { '2026-01-01': 1 });
		row(view, b, 2026, { '2026-01-01': Number.NaN });
		expect(() => seriesFromCache(cells, view, w)).toThrow(FeedNoDataError);
	});

	it('a box leaving out its sea (skipNoData) renormalises, and refuses a land cell going no data on a later day', () => {
		const view = new Map();
		row(view, a, 2026, { '2026-01-01': 1, '2026-01-02': 3 });
		row(view, b, 2026, { '2026-01-01': Number.NaN, '2026-01-02': Number.NaN });
		const noData = { mask: null };
		expect(seriesFromCache(cells, view, w, noData).values).toEqual([1, 3]);
		expect(noData.mask).toBe('10');
		row(view, a, 2026, { '2026-01-01': 1, '2026-01-02': Number.NaN });
		row(view, b, 2026, { '2026-01-01': Number.NaN, '2026-01-02': 2 });
		expect(() => seriesFromCache(cells, view, w, { mask: null })).toThrow(FeedFormatError);
	});

	it('nothing cached is no days', () => {
		expect(seriesFromCache(cells, new Map(), w)).toEqual({ startDate: '2026-01-01', values: [], prelimDays: 0 });
	});
});

describe('cacheOrigin', () => {
	afterEach(() => vi.unstubAllEnvs());
	it('an inline fetch caches as what FEED_SOURCE reads; the production fetcher’s answers are always the real files', () => {
		vi.stubEnv('FEED_FETCHER', '');
		vi.stubEnv('FEED_SOURCE', '');
		expect(cacheOrigin()).toBe('fixtures');
		vi.stubEnv('FEED_SOURCE', 'live');
		expect(cacheOrigin()).toBe('chc');
		// sqs: the fetcher Lambda refuses the fixtures, whatever the worker's own FEED_SOURCE says.
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FEED_SOURCE', 'fixtures');
		expect(cacheOrigin()).toBe('chc');
	});
});
