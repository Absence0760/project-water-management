import { afterEach, describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FeedFormatError, FeedUnavailableError } from '../errors.js';
import { fixtureHttp, fixtureValue } from '../fixtures.js';
import type { FeedHttp } from '../http.js';
import { chirpsFinalUrl, chirpsPrelimUrl, chirpsRnlUrl, fetchChirps, fetchGefs, gefsUrl, gridMean, mapLimit } from './chirps.js';
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
		expect(chirpsRnlUrl('1985-01-02')).toBe('https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/1985/chirps-v3.0.rnl.1985.01.02.tif');
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
		const r = await fetchChirps(http, [cell(0, 0)], '2026-01-30', '2026-02-06', 'sat', 2);
		expect(r).toEqual({ startDate: '2026-01-30', values: [1, 2, 3, null, 5], prelimDays: 2 });
		expect(http.urls).not.toContain(chirpsPrelimUrl('2026-01-30'));
	});

	it('reads the rnl product end to end: its final files only, never sat or a preliminary one (issue #40 part c)', async () => {
		const http = served({
			[chirpsRnlUrl('1997-12-31')]: g(1),
			[chirpsRnlUrl('1998-01-01')]: g(2),
			[chirpsFinalUrl('1998-01-01')]: g(99), // the sat product: never mixed in
			[chirpsPrelimUrl('1998-01-02')]: g(98)
		});
		const r = await fetchChirps(http, [cell(0, 0)], '1997-12-31', '1998-01-03', 'rnl');
		expect(r).toEqual({ startDate: '1997-12-31', values: [1, 2], prelimDays: 0 });
		expect(http.urls.every((u) => u.includes('/final/rnl/'))).toBe(true);
	});

	it('on the fixtures: rnl from 1981, sat only from 1998, each with its own daily timing', async () => {
		const http = fixtureHttp(() => '2026-03-10');
		const at = [{ lat: -20.12, lon: 25.17, weight: 1 }];
		expect((await fetchChirps(http, at, '1985-06-01', '1985-06-03', 'rnl')).values).toHaveLength(3);
		expect((await fetchChirps(http, at, '1985-06-01', '1985-06-03', 'sat')).values).toEqual([]);
		// rnl is the pattern a day later than sat: the same pentads, other daily timing.
		const sat = await fetchChirps(http, at, '2025-06-01', '2025-06-20', 'sat');
		const rnl = await fetchChirps(http, at, '2025-06-02', '2025-06-21', 'rnl');
		expect(rnl.values).toEqual(sat.values);
		// rnl has no preliminary product: nothing within its 6-day lag.
		expect((await fetchChirps(http, at, '2026-03-05', '2026-03-09', 'rnl')).values).toEqual([]);
	});

	describe('the day → file mapping, under a skewed TZ (the calendar is UTC, never local)', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		// Each day's file holds its own day-of-month, so a value names the file it came from.
		const everyDay = (days: string[]) => served(Object.fromEntries(days.map((d) => [chirpsFinalUrl(d), g(Number(d.slice(8)))])));
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
			it(`reads 29 February in a leap year, and no such day otherwise (${zone})`, async () => {
				process.env.TZ = zone;
				const leap = everyDay(['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
				expect((await fetchChirps(leap, [cell(0, 0)], '2024-02-27', '2024-03-01')).values).toEqual([27, 28, 29, 1]);
				expect(leap.urls).toContain(chirpsFinalUrl('2024-02-29'));
				const common = everyDay(['2025-02-27', '2025-02-28', '2025-03-01']);
				expect((await fetchChirps(common, [cell(0, 0)], '2025-02-27', '2025-03-01')).values).toEqual([27, 28, 1]);
				expect(common.urls.some((u) => u.includes('.02.29.'))).toBe(false);
				// 2100 is not a leap year (divisible by 100, not by 400); 2000 was.
				const c2100 = everyDay(['2100-02-28', '2100-03-01']);
				expect((await fetchChirps(c2100, [cell(0, 0)], '2100-02-28', '2100-03-01')).values).toEqual([28, 1]);
				const c2000 = everyDay(['2000-02-28', '2000-02-29', '2000-03-01']);
				expect((await fetchChirps(c2000, [cell(0, 0)], '2000-02-28', '2000-03-01')).values).toEqual([28, 29, 1]);
			});

			it(`crosses the year, and each file's year directory with it (${zone})`, async () => {
				process.env.TZ = zone;
				const http = everyDay(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
				const r = await fetchChirps(http, [cell(0, 0)], '2025-12-30', '2026-01-02');
				expect(r).toEqual({ startDate: '2025-12-30', values: [30, 31, 1, 2], prelimDays: 0 });
				expect(chirpsFinalUrl('2026-01-01')).toContain('/final/sat/2026/chirps-v3.0.sat.2026.01.01.tif');
				expect(chirpsPrelimUrl('2025-12-31')).toContain('/prelim/sat/2025/chirps-v3.0.prelim.2025.12.31.tif');
			});
		}

		it('asks for every day of a 31-, 30- and 28-day month exactly once, in order', async () => {
			const http = served({});
			await fetchChirps(http, [cell(0, 0)], '2025-01-01', '2025-04-30', 'sat', 1);
			const finals = http.urls.filter((u) => u.includes('/final/')).map((u) => u.match(/(\d{4})\.(\d{2})\.(\d{2})\.tif$/)!.slice(1).join('-'));
			expect(finals).toHaveLength(31 + 28 + 31 + 30);
			expect(new Set(finals).size).toBe(finals.length);
			expect(finals.slice(29, 33)).toEqual(['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02']);
			expect(finals.at(-1)).toBe('2025-04-30');
		});
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

	// CHC writes an issue's 16 files one after another over a minute or so
	// (the 2026-09-20 directory: 08:26 to 08:27 UTC). A fetch in that window
	// sees the leading days only; merging them would leave the previous
	// issue's tail in the series, two issues mixed, until the next fetch.
	const issue = (issued: string, days: number[], value = (i: number) => i) =>
		Object.fromEntries(days.map((i) => [gefsUrl(issued, fromEpochDay(toEpochDay(issued) + i)), grid(new Array(8).fill(value(i)))]));

	it('skips a partly published issue for yesterday’s complete one', async () => {
		const http = served({ ...issue('2026-03-10', [0, 1, 2, 3], () => 99), ...issue('2026-03-09', Array.from({ length: 16 }, (_, i) => i)) });
		const f = (await fetchGefs(http, [cell(0, 0)], '2026-03-10'))!;
		expect(f).toEqual({ issued: '2026-03-09', startDate: '2026-03-09', values: Array.from({ length: 16 }, (_, i) => i) });
	});

	it('a day missing inside an issue makes it partial too', async () => {
		const days = Array.from({ length: 16 }, (_, i) => i).filter((i) => i !== 7);
		const http = served({ ...issue('2026-03-10', days, () => 99), ...issue('2026-03-09', Array.from({ length: 16 }, (_, i) => i)) });
		expect((await fetchGefs(http, [cell(0, 0)], '2026-03-10'))!.issued).toBe('2026-03-09');
	});

	it('fails as unavailable (retried soon) when no complete issue is out, rather than merging a partial one', async () => {
		const http = served({ ...issue('2026-03-10', [0, 1, 2]), ...issue('2026-03-09', [0, 1, 2, 3, 4]) });
		const err = await fetchGefs(http, [cell(0, 0)], '2026-03-10').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedUnavailableError);
		expect((err as Error).message).toBe('the newest forecast (issued 2026-03-10) is still being published: 3 of its 16 days are out');
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
