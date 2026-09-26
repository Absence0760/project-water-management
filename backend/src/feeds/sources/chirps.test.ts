import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../errors.js';
import { fixtureHttp, fixtureValue } from '../fixtures.js';
import type { FeedHttp } from '../http.js';
import { chirpsFinalUrl, chirpsPrelimUrl, fetchChirps, fetchGefs, gefsUrl, gridMean, mapLimit } from './chirps.js';
import { writeGrid } from './tiff-write.js';

/** An http that serves given grids by URL, 404 otherwise. */
function served(files: Record<string, Uint8Array>): FeedHttp & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		async range(url, start, end) {
			urls.push(url);
			return files[url]?.subarray(start, end + 1) ?? null;
		},
		async text() {
			return null;
		}
	};
}

/** A 4 x 2 grid from (25.00 E, 20.00 S) holding `values` row-major. */
const grid = (values: number[]) => writeGrid({ width: 4, height: 2, originLon: 25, originLat: -20, scale: 0.05, values });
const cell = (row: number, col: number, weight = 1) => ({ lat: -20.025 - row * 0.05, lon: 25.025 + col * 0.05, weight });

describe('URLs (the CHC layout, checked 2026-09)', () => {
	it('CHIRPS v3 final and preliminary daily files, and the GEFS issue directory', () => {
		expect(chirpsFinalUrl('2026-08-31')).toBe('https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/sat/2026/chirps-v3.0.sat.2026.08.31.tif');
		expect(chirpsPrelimUrl('2026-09-20')).toBe('https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/prelim/sat/2026/chirps-v3.0.prelim.2026.09.20.tif');
		expect(gefsUrl('2026-09-25', '2026-10-01')).toBe('https://data.chc.ucsb.edu/products/CHIRPS-GEFS/v3/daily/global/2026/09/25/c3g_2026.10.01.tif');
	});
});

describe('gridMean', () => {
	const url = 'https://data.chc.ucsb.edu/x.tif';
	it('is the weighted mean of the cells, to 0.01 mm', async () => {
		const http = served({ [url]: grid([1, 2, 3, 4, 10, 20, 30, 40]) });
		expect(await gridMean(http, url, [cell(0, 0)])).toBe(1);
		expect(await gridMean(http, url, [cell(0, 1), cell(1, 3)])).toBe(21);
		expect(await gridMean(http, url, [cell(0, 1, 3), cell(1, 3, 1)])).toBe(11.5);
		expect(await gridMean(http, url, [cell(0, 0, 1), cell(0, 1, 1), cell(0, 2, 1)])).toBe(2);
		expect(await gridMean(served({ [url]: grid([1 / 3, 0, 0, 0, 0, 0, 0, 0]) }), url, [cell(0, 0)])).toBe(0.33);
	});

	it('reads a cell on the grid’s south-east corner (the CHC grid’s is 60° S, 180° E, which config accepts)', async () => {
		const http = served({ [url]: grid([1, 2, 3, 4, 10, 20, 30, 40]) });
		expect(await gridMean(http, url, [{ lat: -20.1, lon: 25.2, weight: 1 }])).toBe(40);
	});

	it('is null when the file is not published', async () => {
		expect(await gridMean(served({}), url, [cell(0, 0)])).toBeNull();
	});

	it('refuses a cell over the sea (-9999) or outside the grid, and an implausible value, instead of skewing the mean', async () => {
		const http = served({ [url]: grid([-9999, 2, -5, 4, 10, 20, 30, 5000]) });
		await expect(gridMean(http, url, [cell(0, 1), cell(0, 0)])).rejects.toThrow(/no data at/);
		await expect(gridMean(http, url, [{ lat: -30, lon: 25.1, weight: 1 }])).rejects.toThrow(FeedFormatError);
		await expect(gridMean(http, url, [cell(0, 2)])).rejects.toThrow(/implausible rainfall/);
		await expect(gridMean(http, url, [cell(1, 3)])).rejects.toThrow(/implausible rainfall/);
	});
});

describe('fetchChirps', () => {
	const g = (v: number) => grid(new Array(8).fill(v));
	it('takes the final value where it is out, else the preliminary, and drops trailing unpublished days', async () => {
		const http = served({
			[chirpsFinalUrl('2026-01-30')]: g(1),
			[chirpsFinalUrl('2026-01-31')]: g(2),
			[chirpsPrelimUrl('2026-01-31')]: g(99), // superseded by the final
			[chirpsPrelimUrl('2026-02-01')]: g(3),
			[chirpsPrelimUrl('2026-02-03')]: g(5) // 02-02 missing between published days
		});
		const r = await fetchChirps(http, [cell(0, 0)], '2026-01-30', '2026-02-06', 2);
		expect(r).toEqual({ startDate: '2026-01-30', values: [1, 2, 3, null, 5], prelimDays: 2 });
		expect(http.urls).not.toContain(chirpsPrelimUrl('2026-01-30'));
	});

	it('returns no days when nothing is published', async () => {
		expect(await fetchChirps(served({}), [cell(0, 0)], '2026-01-01', '2026-01-03')).toEqual({ startDate: '2026-01-01', values: [], prelimDays: 0 });
	});

	it('fails the whole fetch when one day’s file is corrupt (nothing partial is written)', async () => {
		const http = served({ [chirpsFinalUrl('2026-01-01')]: g(1), [chirpsFinalUrl('2026-01-02')]: new TextEncoder().encode('<html>oops</html>') });
		await expect(fetchChirps(http, [cell(0, 0)], '2026-01-01', '2026-01-02')).rejects.toThrow(FeedFormatError);
	});

	it('on the fixtures: a preliminary day reads 10 % high, and the final value replaces it once published', async () => {
		const today = '2026-03-10';
		const http = fixtureHttp(() => today);
		// finalLagDays 40: 2026-01-29 is final, 2026-02-10 preliminary.
		const r = await fetchChirps(http, [{ lat: -20.12, lon: 25.17, weight: 1 }], '2026-01-29', '2026-02-10');
		expect(r.values).toHaveLength(13);
		expect(r.prelimDays).toBe(13 - 1);
		const later = await fetchChirps(fixtureHttp(() => '2026-03-25'), [{ lat: -20.12, lon: 25.17, weight: 1 }], '2026-02-10', '2026-02-10');
		expect(later.prelimDays).toBe(0);
		const prelim = r.values.at(-1)!;
		const final = later.values[0]!;
		expect(prelim).toBeCloseTo(final * 1.1, 1);
	});
});

describe('fetchGefs', () => {
	const cells = [{ lat: -20.12, lon: 25.17, weight: 1 }];
	it('reads the 16 days of today’s issue', async () => {
		const f = (await fetchGefs(fixtureHttp(() => '2026-03-10'), cells, '2026-03-10'))!;
		expect(f.issued).toBe('2026-03-10');
		expect(f.startDate).toBe('2026-03-10');
		expect(f.values).toHaveLength(16);
		expect(f.values.every((v) => typeof v === 'number' && v >= 0)).toBe(true);
	});

	it('falls back to yesterday’s issue before today’s is out, and is null when neither is', async () => {
		const yesterday = served(
			Object.fromEntries(Array.from({ length: 16 }, (_, i) => [gefsUrl('2026-03-09', `2026-03-${String(9 + i).padStart(2, '0')}`), grid(new Array(8).fill(i))]))
		);
		const f = (await fetchGefs(yesterday, [cell(0, 0)], '2026-03-10'))!;
		expect(f.issued).toBe('2026-03-09');
		expect(f.values).toEqual(Array.from({ length: 16 }, (_, i) => i));
		expect(await fetchGefs(served({}), [cell(0, 0)], '2026-03-10')).toBeNull();
	});

	it('keeps only the leading days of a partly published issue', async () => {
		const http = served({ [gefsUrl('2026-03-10', '2026-03-10')]: grid(new Array(8).fill(1)), [gefsUrl('2026-03-10', '2026-03-11')]: grid(new Array(8).fill(2)), [gefsUrl('2026-03-10', '2026-03-13')]: grid(new Array(8).fill(4)) });
		expect((await fetchGefs(http, [cell(0, 0)], '2026-03-10'))!.values).toEqual([1, 2]);
	});
});

describe('the fixture grids', () => {
	it('mark the sea cell, and follow the pattern and gradients', () => {
		const f = { grid: { originLon: 25, originLat: -20, scale: 0.05, width: 8, height: 6, sea: [[5, 7]] as [number, number][] }, colGradient: 0.1, rowGradient: 0, pattern: [10, 20] };
		expect(fixtureValue(f, 0, 5, 7)).toBe(-9999);
		expect(fixtureValue(f, 1, 0, 0)).toBe(20);
		expect(fixtureValue(f, 2, 0, 2)).toBeCloseTo(12);
		expect(fixtureValue(f, -1, 0, 0)).toBe(20);
	});
});

describe('mapLimit', () => {
	it('keeps order and never runs more than the limit at once', async () => {
		let running = 0;
		let peak = 0;
		const out = await mapLimit([5, 1, 4, 2, 3], 2, async (v) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setImmediate(r));
			running--;
			return v * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30]);
		expect(peak).toBe(2);
	});
});
