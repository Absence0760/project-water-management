import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FIXTURE_DIR, fixtureHttp, fixtureValue } from './fixtures.js';
import { writeGrid } from './sources/tiff-write.js';
import { chirpsFinalUrl, gridMean } from './sources/chirps.js';
import { bboxCells } from './config.js';
import { DWS_MAX_YEARS } from './sources/dws.js';
import { FILE_TAG_MAX, type FeedHttp } from './http.js';
import {
	CHIRPS_FIRST_DAYS,
	CHIRPS_MAX_DAYS,
	CHIRPS_REVISION_DAYS,
	FEED_META_MAX_BYTES,
	type CellsResult,
	CellsResult as CellsResultSchema,
	FetchRequestSchema,
	FetchResult,
	fetchWindow,
	gridRead,
	runFetch as runAny,
	utcToday
} from './fetch.js';
import { CELL_VALUE_MAX_BITS, planFetch, RECHECK_HEAD_DAYS, RECHECK_READ_DAYS, seriesFromCache, uniqueCells } from './cellCache.js';
import { gridCells } from './config.js';
import { MAX_MESSAGE_BYTES } from '../jobs/transport.js';
import { viewFromAnswers } from '../__tests__/cellCacheView.js';

/** runFetch for a request without `cells`: the mean, as before the cell cache. */
const runFetch = (...a: Parameters<typeof runAny>) => runAny(...a) as Promise<FetchResult>;
/** runFetch for a request with `cells`: each cell's values. */
const runCells = async (...a: Parameters<typeof runAny>) => {
	const r = await runAny(...a);
	if (!r.ok || !('cells' in r)) throw new Error(`not a cells answer: ${JSON.stringify(r)}`);
	return r as CellsResult;
};

const grid = { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] };

/** The fixtures, but the final CHIRPS file of the day `dotted` (YYYY.MM.DD) drawn from another grid fixture. */
function fixtureHttpWith(other: Parameters<typeof fixtureValue>[0], dotted: string): FeedHttp {
	const base = fixtureHttp(() => '2026-03-10');
	const day = toEpochDay(dotted.replaceAll('.', '-'));
	const { width, height } = other.grid;
	const values = new Float32Array(width * height);
	for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) values[r * width + c] = fixtureValue(other, day, r, c);
	const file = writeGrid({ width, height, originLon: other.grid.originLon, originLat: other.grid.originLat, scale: other.grid.scale, values });
	return { ...base, range: async (url, start, end) => (url.endsWith(`sat.${dotted}.tif`) ? file.subarray(start, end + 1) : base.range(url, start, end)) };
}
const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
	vi.restoreAllMocks();
});

describe('utcToday (CHIRPS and DWS days are UTC calendar days)', () => {
	it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg'])('is the UTC date whatever the machine’s zone (%s)', (zone) => {
		process.env.TZ = zone;
		expect(utcToday(new Date('2026-09-25T23:30:00Z'))).toBe('2026-09-25');
		expect(utcToday(new Date('2026-09-26T00:30:00Z'))).toBe('2026-09-26');
	});
});

describe('fetchWindow', () => {
	it('CHIRPS: the first fetch reads 60 days (or from startDate) to yesterday', () => {
		expect(fetchWindow('chirps', grid, null, '2026-09-25')).toEqual({ start: '2026-07-27', end: '2026-09-24' });
		expect(CHIRPS_FIRST_DAYS).toBe(60);
		expect(fetchWindow('chirps', { ...grid, startDate: '2026-09-01' }, null, '2026-09-25')).toEqual({ start: '2026-09-01', end: '2026-09-24' });
	});

	it('CHIRPS: later fetches re-read 50 days before the newest (preliminary → final) and cap a long catch-up at 120 days', () => {
		expect(fetchWindow('chirps', grid, '2026-09-20', '2026-09-25')).toEqual({ start: '2026-08-01', end: '2026-09-24' });
		expect(CHIRPS_REVISION_DAYS).toBe(50);
		const w = fetchWindow('chirps', { ...grid, startDate: '2020-01-01' }, null, '2026-09-25');
		expect(w).toEqual({ start: '2020-01-01', end: '2020-04-29' });
		expect(CHIRPS_MAX_DAYS).toBe(120);
	});

	it('never reads before a configured startDate, even to re-read revisions (days before it may be the owner’s own data)', () => {
		// A second CHIRPS fetch would otherwise re-read 50 days back, into August.
		expect(fetchWindow('chirps', { ...grid, startDate: '2026-09-01' }, '2026-09-22', '2026-09-25')).toEqual({ start: '2026-09-01', end: '2026-09-24' });
		// Far enough past startDate, the revision window is unchanged.
		expect(fetchWindow('chirps', { ...grid, startDate: '2026-01-01' }, '2026-09-20', '2026-09-25')).toEqual({ start: '2026-08-01', end: '2026-09-24' });
		// DWS re-reads a year, but not across startDate.
		expect(fetchWindow('dws', { station: 'X0H000', startDate: '2026-03-01' }, '2026-06-01', '2026-09-25')).toEqual({ start: '2026-03-01', end: '2026-09-25' });
		expect(fetchWindow('dws', { station: 'X0H000', startDate: '2020-03-01' }, '2026-06-01', '2026-09-25')).toEqual({ start: '2025-06-01', end: '2026-09-25' });
	});

	it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns'])('counts calendar days the same in any machine zone, across a leap day (TZ %s)', (zone) => {
		process.env.TZ = zone;
		expect(fetchWindow('chirps', grid, '2024-02-27', '2024-03-02')).toEqual({ start: '2024-01-08', end: '2024-03-01' });
		expect(fetchWindow('chirps_gefs', grid, null, '2024-02-20')).toEqual({ start: '2024-02-20', end: '2024-03-06' });
		expect(fetchWindow('dws', { station: 'X0H000' }, '2024-02-29', '2024-03-10')).toEqual({ start: '2023-03-01', end: '2024-03-10' });
	});

	it('GEFS: the 16 days from today', () => {
		expect(fetchWindow('chirps_gefs', grid, '2026-10-05', '2026-09-25')).toEqual({ start: '2026-09-25', end: '2026-10-10' });
	});

	it('DWS: ten years to today at first, then a year of revisions before the newest; never over 20 years at once', () => {
		expect(fetchWindow('dws', { station: 'X0H000' }, null, '2026-09-25')).toEqual({ start: '2016-09-27', end: '2026-09-25' });
		expect(fetchWindow('dws', { station: 'X0H000' }, '2026-06-01', '2026-09-25')).toEqual({ start: '2025-06-01', end: '2026-09-25' });
		const w = fetchWindow('dws', { station: 'X0H000', startDate: '1980-01-01' }, null, '2026-09-25');
		// 365 × 20 days, inclusive: inside the site's 20-year limit.
		expect(w).toEqual({ start: '1980-01-01', end: '1999-12-26' });
	});

	// Issue #29: the newest date is the only other progress marker, so a
	// window with no data in it (before the station's record, or a gap longer
	// than one window) came round again every fetch, forever.
	it.each(['Pacific/Kiritimati', 'America/St_Johns'])('moves past a stretch it read and found empty, until it reaches the data (TZ %s)', (zone) => {
		process.env.TZ = zone;
		const today = '2026-09-25';
		const config = { station: 'X0H000', startDate: '1960-01-01' };
		// The station's record starts in 1985: every window before that comes back empty.
		let last: string | null = null;
		let through: string | null = null;
		const windows: { start: string; end: string }[] = [];
		for (let i = 0; i < 4; i++) {
			const w = fetchWindow('dws', config, last, today, through);
			windows.push(w);
			through = w.end;
			if (w.end >= '1985-01-01') last = w.end; // data all the way through the window from 1985 on
		}
		expect(windows[0]).toEqual({ start: '1960-01-01', end: '1979-12-26' });
		// The next window starts a revision year before the last day read, not back at 1960.
		expect(windows[1]).toEqual({ start: '1978-12-27', end: '1998-12-21' });
		// Then it runs on the data as before: a year of revisions before the newest day.
		expect(windows[2]!.start).toBe('1997-12-21');
		expect(windows[3]!.start > windows[2]!.start).toBe(true);

		// A gap longer than one window: the newest day is from 1990, the last read ended in 2009.
		expect(fetchWindow('dws', config, '1990-06-30', today, '2009-06-26')).toEqual({ start: '2008-06-27', end: today });
		// CHIRPS the same, with its own revision and cap.
		expect(fetchWindow('chirps', { ...grid, startDate: '2020-01-01' }, null, today, '2020-04-29')).toEqual({ start: '2020-03-11', end: '2020-07-08' });
	});

	it('a caught-up feed keeps its revision window: the last read reaching past the newest day moves nothing', () => {
		// DWS lags months behind today; every daily fetch reads to today.
		expect(fetchWindow('dws', { station: 'X0H000' }, '2026-06-01', '2026-09-25', '2026-09-24')).toEqual({ start: '2025-06-01', end: '2026-09-25' });
		expect(fetchWindow('dws', { station: 'X0H000' }, '2026-06-01', '2026-09-25', '2026-09-25')).toEqual({ start: '2025-06-01', end: '2026-09-25' });
		expect(fetchWindow('chirps', grid, '2026-09-20', '2026-09-25', '2026-09-24')).toEqual({ start: '2026-08-01', end: '2026-09-24' });
		// A catch-up that is finding data moves on through the newest date as before.
		expect(fetchWindow('chirps', { ...grid, startDate: '2020-01-01' }, '2020-04-29', '2026-09-25', '2020-04-29')).toEqual({ start: '2020-03-10', end: '2020-07-07' });
		// GEFS reads the 16 days from today whatever was read before.
		expect(fetchWindow('chirps_gefs', grid, null, '2026-09-25', '2026-10-09')).toEqual({ start: '2026-09-25', end: '2026-10-10' });
	});
});

// Issue #69: a final CHIRPS value is never revised, so the revision re-read
// starts after the feed's final marker (last_meta.finalThrough).
describe('fetchWindow with the final marker (CHIRPS)', () => {
	const today = '2026-09-25';
	it('starts the re-read after the last final day, and ignores a marker the window already starts after', () => {
		expect(fetchWindow('chirps', grid, '2026-09-20', today, '2026-09-24')).toEqual({ start: '2026-08-01', end: '2026-09-24' });
		expect(fetchWindow('chirps', grid, '2026-09-20', today, '2026-09-24', '2026-08-15')).toEqual({ start: '2026-08-16', end: '2026-09-24' });
		expect(fetchWindow('chirps', grid, '2026-09-20', today, '2026-09-24', '2026-07-01')).toEqual({ start: '2026-08-01', end: '2026-09-24' });
		expect(fetchWindow('chirps', grid, '2026-09-20', today, '2026-09-24', '2026-08-01')).toEqual({ start: '2026-08-02', end: '2026-09-24' });
	});

	it('never starts past the window’s end: final through yesterday (or later) leaves one day', () => {
		expect(fetchWindow('chirps', grid, '2026-09-24', today, '2026-09-24', '2026-09-23')).toEqual({ start: '2026-09-24', end: '2026-09-24' });
		expect(fetchWindow('chirps', grid, '2026-09-24', today, '2026-09-24', '2026-09-24')).toEqual({ start: '2026-09-24', end: '2026-09-24' });
		expect(fetchWindow('chirps', grid, '2026-09-24', today, '2026-09-24', '2026-10-30')).toEqual({ start: '2026-09-24', end: '2026-09-24' });
	});

	it('the 120-day cap counts from the moved start: a backfill of final days has no overlap', () => {
		const config = { ...grid, startDate: '2020-01-01' };
		// Without the marker a backfill window re-reads 50 days of the last one.
		expect(fetchWindow('chirps', config, '2020-04-29', today, '2020-04-29')).toEqual({ start: '2020-03-10', end: '2020-07-07' });
		expect(fetchWindow('chirps', config, '2020-04-29', today, '2020-04-29', '2020-04-29')).toEqual({ start: '2020-04-30', end: '2020-08-27' });
		// The #29 case (the last window read was empty): the marker moves it on the same way.
		expect(fetchWindow('chirps', config, null, today, '2020-04-29')).toEqual({ start: '2020-03-11', end: '2020-07-08' });
		expect(fetchWindow('chirps', config, null, today, '2020-04-29', '2020-04-29')).toEqual({ start: '2020-04-30', end: '2020-08-27' });
		const w = fetchWindow('chirps', config, '2020-04-29', today, '2020-04-29', '2020-04-29');
		expect(Date.parse(w.end) - Date.parse(w.start)).toBe((CHIRPS_MAX_DAYS - 1) * 86_400_000);
	});

	it('keeps the startDate floor, and a startDate in the future still asks for no days', () => {
		const config = { ...grid, startDate: '2026-09-01' };
		expect(fetchWindow('chirps', config, '2026-09-22', today, '2026-09-24', '2026-08-20')).toEqual({ start: '2026-09-01', end: '2026-09-24' });
		expect(fetchWindow('chirps', config, '2026-09-22', today, '2026-09-24', '2026-09-10')).toEqual({ start: '2026-09-11', end: '2026-09-24' });
		expect(fetchWindow('chirps', { ...grid, startDate: '2026-10-05' }, null, today, null, '2026-10-10')).toEqual({ start: '2026-10-05', end: '2026-09-24' });
	});

	it('only CHIRPS: the forecast and DWS ignore it', () => {
		expect(fetchWindow('chirps_gefs', grid, '2026-10-05', today, null, '2026-09-30')).toEqual({ start: '2026-09-25', end: '2026-10-10' });
		expect(fetchWindow('dws', { station: 'X0H000' }, '2026-06-01', today, '2026-09-25', '2026-06-01')).toEqual({ start: '2025-06-01', end: '2026-09-25' });
	});

	// What the marker and the cell cache save, on the fixtures (sat final up
	// to 40 days back, preliminary to 3; rnl final to 40, published with sat's
	// finals): the range requests of a caught-up feed's daily fetch without
	// either, and with both (#69, #482). Before #69 the same fetch took 194
	// (sat) and 158 (rnl, then 6 days behind): every day probed its final file
	// and re-read its preliminary one. The cache asks for no day it holds
	// final, and only the final file of a day it holds preliminary, as the
	// held days did before it; rnl probes its finals as sat does, so the day
	// after the marker, not out yet, is the one file it asks for (reading to
	// yesterday asked for all 39).
	it.each([
		['sat', 160, 3],
		['rnl', 157, 1]
	] as const)('a caught-up %s feed’s daily fetch: %i range requests without them, %i with them', async (product, before, after) => {
		const day = '2026-03-10';
		const fixtures = fixtureHttp(() => day);
		let n = 0;
		const http: FeedHttp = { range: (u, s, e) => (n++, fixtures.range(u, s, e)), text: fixtures.text };
		const config = { ...grid, product };
		const cells = uniqueCells(gridCells(config));
		const first = fetchWindow('chirps', config, null, day);
		const plan = planFetch(cells, new Map(), first)!;
		const answer = await runCells({ source: 'chirps', config, ...first, today: day, cells: { cells: plan.cells.map((c) => [c.row, c.col]), plan: plan.plan } }, http);
		const view = viewFromAnswers([answer.cells]);
		const r = seriesFromCache(gridCells(config), view, first);
		const newest = new Date(Date.parse(`${r.startDate}T00:00:00Z`) + (r.values.length - 1) * 86_400_000).toISOString().slice(0, 10);
		expect(r.finalThrough).toBe('2026-01-29');
		// Without the marker or the cache: the mean read from the files, every day of the re-read window.
		n = 0;
		const w0 = fetchWindow('chirps', config, newest, day, first.end, null);
		expect(w0.end).toBe(first.end);
		const again = await runFetch({ source: 'chirps', config, ...w0, today: day }, http);
		expect(again.ok ? (again.meta.prelimDays ?? 0) : null).toBe(product === 'sat' ? 37 : 0);
		expect(n).toBe(before);
		// With both: the window starts after the marker, and the plan reads only what the cache can't give.
		n = 0;
		const w = fetchWindow('chirps', config, newest, day, first.end, r.finalThrough);
		// Every day after the marker is still in the window, through yesterday: nothing the re-read could revise is skipped.
		expect(w.end).toBe(first.end);
		expect(w.start).toBe(new Date(Date.parse(`${r.finalThrough}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
		const next = planFetch(cells, view, w)!;
		const cached = await runCells({ source: 'chirps', config, ...w, today: day, cells: { cells: next.cells.map((c) => [c.row, c.col]), plan: next.plan } }, http);
		expect(n).toBe(after);
		// The feed card's preliminary count is the same either way.
		expect(seriesFromCache(gridCells(config), viewFromAnswers([cached.cells], view), w).prelimDays).toBe(product === 'sat' ? 37 : 0);
	});
});

describe('runFetch on the fixtures', () => {
	const http = fixtureHttp(() => '2026-03-10');
	it('CHIRPS: days up to the preliminary lag, with how many are preliminary', async () => {
		const r = await runFetch({ source: 'chirps', config: grid, start: '2026-02-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(r).toMatchObject({ ok: true, startDate: '2026-02-20', meta: { days: 16, prelimDays: 16 } });
		expect(FetchResult.parse(r)).toEqual(r);
	});

	it('GEFS: the issue', async () => {
		const r = await runFetch({ source: 'chirps_gefs', config: grid, start: '2026-03-10', end: '2026-03-25', today: '2026-03-10' }, http);
		expect(r).toMatchObject({ ok: true, startDate: '2026-03-10', meta: { days: 16, issued: '2026-03-10' } });
	});

	it('DWS: the replayed page, gaps as null', async () => {
		const r = await runFetch({ source: 'dws', config: { station: 'X0H000' }, start: '2025-01-01', end: '2026-03-10', today: '2026-03-10' }, http);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.startDate).toBe('2025-01-01');
		expect(r.values.some((v) => v === null)).toBe(true);
		expect(r.meta).toMatchObject({ 'quality 1': expect.any(Number) });
		expect(FetchResult.parse(r)).toEqual(r);
	});

	it('DWS: keeps only the days asked for, never a day after today', async () => {
		const table = ['DATE D_AVG_FR QUAL', '20201231 9 1', '20210101 1 1', '20210102 2 1', '20210103 3 1', '20300101 7 1'].join('\n');
		const http: FeedHttp = { range: async () => null, text: async () => `<pre>${table}</pre>` };
		const r = await runFetch({ source: 'dws', config: { station: 'X0H000' }, start: '2021-01-01', end: '2021-01-10', today: '2021-01-02' }, http);
		expect(r).toEqual({ ok: true, startDate: '2021-01-01', values: [1, 2], meta: { days: 2, gaps: 0, outside: 3, 'quality 1': 2 } });
		const none = await runFetch({ source: 'dws', config: { station: 'X0H000' }, start: '2022-01-01', end: '2022-01-10', today: '2022-01-10' }, http);
		expect(none).toEqual({ ok: true, startDate: null, values: [], meta: { days: 0, gaps: 0, outside: 5 } });
	});

	it('CHIRPS over a bounding box: the area-weighted mean of the cells it overlaps, as computed by hand', async () => {
		// Rows 1 (−20.05…−20.10, whole) and 2 (−20.10…−20.13 of −20.15, 0.6); columns 2 (25.12…25.15 of 25.10, 0.6) and 3 (whole).
		const bbox = { south: -20.13, west: 25.12, north: -20.05, east: 25.2 };
		const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
		const r = await runFetch({ source: 'chirps', config: { bbox }, start: days[0]!, end: days.at(-1)!, today: '2026-03-10' }, http);
		const f = JSON.parse(readFileSync(`${FIXTURE_DIR}chirps-sample.json`, 'utf8'));
		const cos = (lat: number) => Math.cos((lat * Math.PI) / 180);
		const parts = [
			{ row: 1, col: 2, w: 0.6 * cos(-20.075) },
			{ row: 1, col: 3, w: cos(-20.075) },
			{ row: 2, col: 2, w: 0.36 * cos(-20.125) },
			{ row: 2, col: 3, w: 0.6 * cos(-20.125) }
		];
		const byHand = days.map((d) => {
			const k = toEpochDay(d);
			const sum = parts.reduce((s, p) => s + p.w * fixtureValue(f, k, p.row, p.col), 0);
			return Math.round((sum / parts.reduce((s, p) => s + p.w, 0)) * 100) / 100;
		});
		expect(byHand.some((v) => v > 0)).toBe(true);
		expect(r).toEqual({ ok: true, startDate: days[0], values: byHand, meta: { days: 4, prelimDays: 0, product: 'sat', finalThrough: '2026-01-04' } });
	});

	it('a box with skipNoData over the fixture sea cell: the renormalised mean of the land cells, and how many it used', async () => {
		// Rows 4–5 × columns 6–7 of the sample grid; the cell at row 5, col 7 is sea (chirps-sample.json `sea`).
		const bbox = { south: -20.3, west: 25.3, north: -20.2, east: 25.4 };
		const f = JSON.parse(readFileSync(`${FIXTURE_DIR}chirps-sample.json`, 'utf8'));
		expect(f.grid.sea).toEqual([[5, 7]]);
		const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
		const r = await runFetch({ source: 'chirps', config: { bbox, skipNoData: true }, start: days[0]!, end: days.at(-1)!, today: '2026-03-10' }, http);
		const cos = (lat: number) => Math.cos((lat * Math.PI) / 180);
		// The three land cells, whole cells each: the sea cell's weight is left out, the rest renormalised.
		const land = [
			{ row: 4, col: 6, w: cos(-20.225) },
			{ row: 4, col: 7, w: cos(-20.225) },
			{ row: 5, col: 6, w: cos(-20.275) }
		];
		const byHand = days.map((d) => {
			const k = toEpochDay(d);
			return Math.round((land.reduce((s, p) => s + p.w * fixtureValue(f, k, p.row, p.col), 0) / land.reduce((s, p) => s + p.w, 0)) * 100) / 100;
		});
		expect(byHand.some((v) => v > 0)).toBe(true);
		expect(r).toEqual({ ok: true, startDate: days[0], values: byHand, meta: { days: 4, prelimDays: 0, product: 'sat', cellsUsed: 3, finalThrough: '2026-01-04' } });
		// The forecast the same.
		const g = await runFetch({ source: 'chirps_gefs', config: { bbox, skipNoData: true }, start: '2026-03-10', end: '2026-03-25', today: '2026-03-10' }, http);
		expect(g).toMatchObject({ ok: true, meta: { days: 16, cellsUsed: 3 } });
	});

	it('a box with skipNoData still fails when no cell has data, and when a land cell reads no data on one day of the fetch', async () => {
		const sea = { south: -20.3, west: 25.35, north: -20.25, east: 25.4 };
		const allSea = await runFetch({ source: 'chirps', config: { bbox: sea, skipNoData: true }, start: '2026-01-01', end: '2026-01-01', today: '2026-03-10' }, http);
		expect(allSea).toEqual({ ok: false, error: 'the source’s data could not be read: the grid has no data in any cell of the bounding box (all sea, or outside the product’s coverage)' });

		// 2026-01-02's file has a second no-data cell: a corrupt or changed grid, not the sea.
		const f = JSON.parse(readFileSync(`${FIXTURE_DIR}chirps-sample.json`, 'utf8'));
		const changed = fixtureHttpWith({ ...f, grid: { ...f.grid, sea: [...f.grid.sea, [4, 6]] } }, '2026.01.02');
		const r = await runFetch(
			{ source: 'chirps', config: { bbox: { south: -20.3, west: 25.3, north: -20.2, east: 25.4 }, skipNoData: true }, start: '2026-01-01', end: '2026-01-03', today: '2026-03-10' },
			changed
		);
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/cells with data changed from one day to another within one fetch/) });
	});

	it('a day with no data in any cell, after another day of the fetch had some, reads as a corrupt or changed grid, not the sea', async () => {
		const cells = bboxCells({ south: -20.3, west: 25.3, north: -20.2, east: 25.4 });
		const f = JSON.parse(readFileSync(`${FIXTURE_DIR}chirps-sample.json`, 'utf8'));
		const drowned = fixtureHttpWith({ ...f, grid: { ...f.grid, sea: [[4, 6], [4, 7], [5, 6], [5, 7]] } }, '2026.01.02');
		const url = chirpsFinalUrl('2026-01-02');
		await expect(gridMean(drowned, url, cells, { mask: '1110' })).rejects.toThrow(/the file looks corrupt, or the grid has changed/);
		// The first day read: all sea, said so.
		await expect(gridMean(drowned, url, cells, { mask: null })).rejects.toThrow(/no data in any cell of the bounding box \(all sea/);
	});

	it('GEFS over a bounding box', async () => {
		const r = await runFetch({ source: 'chirps_gefs', config: { bbox: { south: -20.2, west: 25.1, north: -20.1, east: 25.2 } }, start: '2026-03-10', end: '2026-03-25', today: '2026-03-10' }, http);
		expect(r).toMatchObject({ ok: true, startDate: '2026-03-10', meta: { days: 16, issued: '2026-03-10' } });
	});

	it('CHIRPS: how far the leading days are final (finalThrough), and none when the first day is preliminary', async () => {
		const r = await runFetch({ source: 'chirps', config: grid, start: '2026-01-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(r).toMatchObject({ ok: true, meta: { finalThrough: '2026-01-29', prelimDays: 37 } });
		const prelim = await runFetch({ source: 'chirps', config: grid, start: '2026-02-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(prelim.ok && prelim.meta).not.toHaveProperty('finalThrough');
		const rnl = await runFetch({ source: 'chirps', config: { ...grid, product: 'rnl' }, start: '2026-01-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(rnl).toMatchObject({ ok: true, meta: { days: 10, finalThrough: '2026-01-29', prelimDays: 0 } });
	});

	it('CHIRPS with nothing published yet: ok, no days', async () => {
		const r = await runFetch({ source: 'chirps', config: grid, start: '2026-03-09', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(r).toEqual({ ok: true, startDate: null, values: [], meta: { days: 0, product: 'sat' } });
	});
});

describe('runFetch failures: a result with our message, never a throw or an upstream body', () => {
	const broken = (over: Partial<FeedHttp>): FeedHttp => ({ range: async () => null, text: async () => null, ...over });

	it('a cell over the fixture sea', async () => {
		const r = await runFetch({ source: 'chirps', config: { cells: [{ lat: -20.27, lon: 25.37, weight: 1 }] }, start: '2026-01-01', end: '2026-01-01', today: '2026-03-10' }, fixtureHttp(() => '2026-03-10'));
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/^the source’s data could not be read: the grid has no data at -20.27, 25.37/) });
	});

	it('a bounding box over the fixture sea fails loudly and says how to fix it (a box never skips a cell)', async () => {
		const bbox = { south: -20.3, west: 25.3, north: -20.2, east: 25.4 };
		const r = await runFetch({ source: 'chirps', config: { bbox }, start: '2026-01-01', end: '2026-01-01', today: '2026-03-10' }, fixtureHttp(() => '2026-03-10'));
		expect(r).toEqual({
			ok: false,
			error: 'the source’s data could not be read: the grid has no data at -20.275, 25.375 (the sea, or outside the product’s coverage), inside the bounding box: shrink the box to the land, list the cells instead, or let the feed leave out sea cells (skipNoData)'
		});
	});

	it('no GEFS issue today or yesterday', async () => {
		const r = await runFetch({ source: 'chirps_gefs', config: grid, start: '2026-03-10', end: '2026-03-25', today: '2026-03-10' }, broken({}));
		expect(r).toEqual({ ok: false, error: 'the source’s data could not be read: no forecast was issued today or yesterday' });
	});

	it('a GEFS issue caught half-written, with no complete one to fall back on: unavailable, nothing merged', async () => {
		const fixture = fixtureHttp(() => '2026-03-10');
		// Today's issue has its first four days out; yesterday's none (a fresh feed at 08:26 UTC).
		const halfWritten = broken({
			range: (url, start, end) => (/\/2026\/03\/10\/c3g_2026\.03\.1[0-3]\.tif$/.test(url) ? fixture.range(url, start, end) : Promise.resolve(null))
		});
		const r = await runFetch({ source: 'chirps_gefs', config: grid, start: '2026-03-10', end: '2026-03-25', today: '2026-03-10' }, halfWritten);
		expect(r).toEqual({ ok: false, error: 'the source is unreachable: the newest forecast (issued 2026-03-10) is still being published: 4 of its 16 days are out' });
	});

	it('a DWS page that changed format, or went missing', async () => {
		const page = '<html><pre>DATE FLOW\n20210101 1</pre></html>';
		const r = await runFetch({ source: 'dws', config: { station: 'X0H000' }, start: '2021-01-01', end: '2021-01-02', today: '2026-03-10' }, broken({ text: async () => page }));
		expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/columns changed/) });
		const gone = await runFetch({ source: 'dws', config: { station: 'X0H000' }, start: '2021-01-01', end: '2021-01-02', today: '2026-03-10' }, broken({}));
		expect(gone).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
	});

	it('an unexpected error: a generic message, logged in full server-side only', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const r = await runFetch(
			{ source: 'dws', config: { station: 'X0H000' }, start: '2021-01-01', end: '2021-01-02', today: '2026-03-10' },
			broken({ text: async () => { throw new Error('secret internal detail at 10.0.0.1'); } })
		);
		expect(r).toEqual({ ok: false, error: 'the fetch failed with an internal error' });
		expect(spy).toHaveBeenCalled();
	});
});

describe('FetchResult (the fetcher’s output is untrusted)', () => {
	it.each([
		['negative rain or flow', { ok: true, startDate: '2026-01-01', values: [-1], meta: {} }],
		['Infinity', { ok: true, startDate: '2026-01-01', values: [1e400], meta: {} }],
		['not a calendar date', { ok: true, startDate: '2026-02-30', values: [1], meta: {} }],
		['values without a start', { ok: true, startDate: null, values: [1], meta: {} }],
		['extra fields', { ok: true, startDate: '2026-01-01', values: [1], meta: {}, sql: 'x' }],
		['too many meta keys', { ok: true, startDate: '2026-01-01', values: [1], meta: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }],
		['a nested meta value', { ok: true, startDate: '2026-01-01', values: [1], meta: { a: { b: 1 } } }],
		['over 60 000 days', { ok: true, startDate: '2026-01-01', values: new Array(60_001).fill(0), meta: {} }],
		['an empty error', { ok: false, error: '' }],
		['a huge error', { ok: false, error: 'x'.repeat(501) }],
		// What data_feed would refuse after the merge (the job would die retrying instead of recording a failure).
		['meta over its byte budget in multi-byte characters', { ok: true, startDate: '2026-01-01', values: [1], meta: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}`.padEnd(40, '€'), ''.padEnd(100, '€')])) }],
		['a NUL in a meta value', { ok: true, startDate: '2026-01-01', values: [1], meta: { a: 'x\u0000' } }],
		['a NUL in a meta key', { ok: true, startDate: '2026-01-01', values: [1], meta: { 'a\u0000': 1 } }],
		['a NUL in the error', { ok: false, error: 'x\u0000' }]
	])('refuses %s', (_, value) => {
		expect(FetchResult.safeParse(value).success).toBe(false);
	});

	it('accepts a result with gaps, and an empty one', () => {
		expect(FetchResult.safeParse({ ok: true, startDate: '2026-01-01', values: [1, null, 0], meta: { days: 3 } }).success).toBe(true);
		expect(FetchResult.safeParse({ ok: true, startDate: null, values: [], meta: {} }).success).toBe(true);
	});

	it('accepts the largest ASCII meta the per-field limits allow (the byte budget only bites on multi-byte text)', () => {
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}`.padEnd(40, 'k'), ''.padEnd(100, 'v')]));
		expect(Buffer.byteLength(JSON.stringify(meta))).toBeLessThanOrEqual(FEED_META_MAX_BYTES);
		expect(FetchResult.safeParse({ ok: true, startDate: '2026-01-01', values: [1], meta }).success).toBe(true);
	});
});

describe('FetchRequestSchema (what the fetcher Lambda accepts)', () => {
	it('checks the config against the source’s own schema', () => {
		const base = { start: '2026-01-01', end: '2026-01-02', today: '2026-01-03' };
		expect(FetchRequestSchema.safeParse({ ...base, source: 'dws', config: { station: 'X0H000' } }).success).toBe(true);
		expect(FetchRequestSchema.safeParse({ ...base, source: 'dws', config: grid }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...base, source: 'chirps', config: { station: 'X0H000' } }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...base, source: 'chirps', config: grid, extra: 1 }).success).toBe(false);
	});

	// A bounding box's limits are all that keeps a queue message from making
	// the fetcher read many cells: the schema checks them again here.
	it('checks a bounding box: a valid one parses; too big, with cells, or with an unknown key is refused', () => {
		const base = { source: 'chirps', start: '2026-01-01', end: '2026-01-02', today: '2026-01-03' };
		const bbox = { south: -20.2, west: 25.1, north: -20.1, east: 25.2 };
		expect(FetchRequestSchema.safeParse({ ...base, config: { bbox } })).toMatchObject({ success: true, data: { config: { bbox } } });
		expect(FetchRequestSchema.safeParse({ ...base, source: 'chirps_gefs', config: { bbox } }).success).toBe(true);
		// 400 cells in 20 rows.
		expect(FetchRequestSchema.safeParse({ ...base, config: { bbox: { south: -21, west: 25, north: -20, east: 26 } } }).success).toBe(false);
		// 26 rows of one cell.
		expect(FetchRequestSchema.safeParse({ ...base, config: { bbox: { south: -21.3, west: 25, north: -20, east: 25.05 } } }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...base, config: { ...grid, bbox } }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...base, config: { bbox: { ...bbox, cells: 1000 } } }).success).toBe(false);
		// Leaving out sea cells is a box's option only.
		expect(FetchRequestSchema.safeParse({ ...base, config: { bbox, skipNoData: true } }).success).toBe(true);
		expect(FetchRequestSchema.safeParse({ ...base, config: { ...grid, skipNoData: true } }).success).toBe(false);
		expect(FetchRequestSchema.safeParse({ ...base, config: { ...grid, skipNoData: false } }).success).toBe(false);
	});

	// The fetcher is the door to the internet: a request can't make it read
	// more than one fetchWindow would ever ask for.
	it('refuses a window longer than the source’s own cap', () => {
		const req = (source: string, config: unknown, start: string, end: string) =>
			FetchRequestSchema.safeParse({ source, config, start, end, today: '2026-06-01' }).success;
		const add = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
		expect(req('chirps', grid, '2026-01-01', add('2026-01-01', CHIRPS_MAX_DAYS - 1))).toBe(true);
		expect(req('chirps', grid, '2026-01-01', add('2026-01-01', CHIRPS_MAX_DAYS))).toBe(false);
		expect(req('chirps', grid, '1981-01-01', '2026-05-31')).toBe(false);
		expect(req('dws', { station: 'X0H000' }, '2006-06-01', add('2006-06-01', 365 * DWS_MAX_YEARS - 1))).toBe(true);
		expect(req('dws', { station: 'X0H000' }, '1906-06-01', '2026-06-01')).toBe(false);
		// An empty window (a start date configured in the future) is fine: it reads nothing.
		expect(req('chirps', grid, '2026-07-01', '2026-05-31')).toBe(true);
	});

	// A queue message: heldThrough only ever names a CHIRPS day inside the window (from a worker before the cell cache).
	it('takes heldThrough only as a CHIRPS sat day inside the window', () => {
		const req = (source: string, config: unknown, held: unknown) =>
			FetchRequestSchema.safeParse({ source, config, start: '2026-01-01', end: '2026-01-31', today: '2026-02-01', heldThrough: held }).success;
		expect(req('chirps', grid, '2026-01-01')).toBe(true);
		expect(req('chirps', grid, '2026-01-31')).toBe(true);
		expect(req('chirps', grid, undefined)).toBe(true);
		for (const bad of ['2025-12-31', '2026-02-01', '2026-02-30', 'soon', 7, null]) expect(req('chirps', grid, bad), String(bad)).toBe(false);
		expect(req('dws', { station: 'X0H000' }, '2026-01-10')).toBe(false);
		expect(req('chirps_gefs', grid, '2026-01-10')).toBe(false);
		// rnl has no preliminary days to hold.
		expect(req('chirps', { ...grid, product: 'rnl' }, '2026-01-10')).toBe(false);
		expect(req('chirps', { ...grid, product: 'rnl' }, undefined)).toBe(true);
	});

	it('every window fetchWindow asks for passes (positive control)', () => {
		const today = '2026-06-01';
		for (const last of [null, '2026-05-28', '2020-01-01', '1990-01-01']) {
			for (const [source, config] of [['chirps', { ...grid, startDate: '1990-01-01' }], ['chirps', grid], ['chirps_gefs', grid], ['dws', { station: 'X0H000', startDate: '1950-01-01' }], ['dws', { station: 'X0H000' }]] as const) {
				for (const through of [null, '2026-05-31', '2020-03-01', '1995-01-01', '1970-12-31']) {
					for (const final of [null, '2026-05-31', '2026-05-01', '2020-03-01', '1995-01-01']) {
						const w = fetchWindow(source, config as never, last, today, through, final);
						expect(FetchRequestSchema.safeParse({ source, config, ...w, today }).success, `${source} ${last} ${through} ${final}`).toBe(true);
						// With the cell cache's plan: one day per day of the window (none for an empty one, which sends no plan).
						const days = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 86_400_000) + 1;
						if (source === 'chirps' && days > 0) {
							expect(FetchRequestSchema.safeParse({ source, config, ...w, today, cells: { cells: [[1, 2]], plan: '0'.repeat(days) } }).success, `${last} ${through} ${final}`).toBe(true);
						}
					}
				}
			}
		}
	});
});

describe('FetchResult meta fits its column (018_feeds.sql: 4 KB of JSON)', () => {
	it('refuses meta over FEED_META_MAX_BYTES of UTF-8 JSON, even within the key and length limits', () => {
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'é'.repeat(38)}`, 'é'.repeat(100)]));
		expect(FetchResult.safeParse({ ok: true, startDate: '2026-01-01', values: [1], meta }).success).toBe(false);
		expect(FEED_META_MAX_BYTES).toBeLessThan(4096);
	});
});

describe('the cell cache path (issue #482): each cell’s values, merged, then the mean computed from the cache', () => {
	const today = '2026-03-10';
	const http = fixtureHttp(() => today);
	const plain = { start: '2026-01-15', end: '2026-03-09' };
	const sea = { south: -20.3, west: 25.3, north: -20.2, east: 25.4 };
	/** The fetch as the feed_fetch job makes it from an empty cache, and the feed's days from the cache it leaves. */
	async function viaCache(config: Parameters<typeof gridCells>[0], w: { start: string; end: string }) {
		const plan = planFetch(uniqueCells(gridCells(config)), new Map(), w)!;
		const answer = await runCells({ source: 'chirps', config, ...w, today, cells: { cells: plan.cells.map((c) => [c.row, c.col]), plan: plan.plan } }, http);
		expect(CellsResultSchema.parse(answer)).toEqual(answer);
		const { noData, used } = gridRead(config);
		return { answer, days: seriesFromCache(gridCells(config), viewFromAnswers([answer.cells]), w, noData), used: used() };
	}

	it.each([
		['a listed cell, sat (final then preliminary)', grid, plain],
		['a listed cell, rnl', { ...grid, product: 'rnl' as const }, plain],
		['a bounding box, area weighted', { bbox: { south: -20.13, west: 25.12, north: -20.05, east: 25.2 } }, plain],
		['a coastal box leaving out its sea cell', { bbox: sea, skipNoData: true }, plain],
		['across a year end', grid, { start: '2025-12-20', end: '2026-01-10' }]
	])('%s: the same days, preliminary count, final marker and cells used as reading the mean', async (_label, config, w) => {
		const before = await runFetch({ source: 'chirps', config, ...w, today }, http);
		if (!before.ok) throw new Error(before.error);
		const { days, used } = await viaCache(config, w);
		expect(days.values).toEqual(before.values);
		expect(days.prelimDays).toBe(before.meta.prelimDays);
		expect(days.finalThrough).toBe(before.meta.finalThrough);
		expect(used.cellsUsed).toBe(before.meta.cellsUsed);
	});

	it('answers each cell’s own values: the sea as -1, a day not out as unread', async () => {
		const { answer } = await viaCache({ bbox: sea, skipNoData: true }, plain);
		expect(answer.cells.cells).toHaveLength(4);
		// The fixture's sea cell (row 5, col 7 of its grid) is the box's south-east cell.
		const seaRow = answer.cells.values[3]!;
		expect(seaRow.filter((v) => v !== null).every((v) => v === -1)).toBe(true);
		// Final through 40 days back, preliminary to 3, nothing for the last two days.
		expect(answer.cells.read).toBe(`${'f'.repeat(15)}${'p'.repeat(37)}--`);
		expect(answer.meta).toEqual({ product: 'sat', daysRead: 52, cellDaysRead: 208 });
	});

	it('the request takes a plan only for CHIRPS, one day per day of the window, of cells of the grid', () => {
		const ok = { source: 'chirps', config: grid, start: '2026-01-01', end: '2026-01-03', today };
		const req = (over: Record<string, unknown>) => FetchRequestSchema.safeParse({ ...ok, ...over }).success;
		expect(req({ cells: { cells: [[1600, 4100]], plan: '012' } })).toBe(true);
		expect(req({ cells: { cells: [[1600, 4100]], plan: '01' } })).toBe(false);
		expect(req({ cells: { cells: [[1600, 4100]], plan: '013' } })).toBe(false);
		expect(req({ cells: { cells: [], plan: '000' } })).toBe(false);
		expect(req({ cells: { cells: [[1600, 4100], [1600, 4100]], plan: '000' } })).toBe(false);
		expect(req({ cells: { cells: [[2400, 0]], plan: '000' } })).toBe(false);
		expect(req({ cells: { cells: [[0, 7200]], plan: '000' } })).toBe(false);
		expect(req({ cells: { cells: [[1.5, 3]], plan: '000' } })).toBe(false);
		// The same read cost as a feed's own cells: at most 25 grid rows.
		expect(req({ cells: { cells: Array.from({ length: 25 }, (_, i) => [i, 0]), plan: '000' } })).toBe(true);
		expect(req({ cells: { cells: Array.from({ length: 26 }, (_, i) => [i, 0]), plan: '000' } })).toBe(false);
		// Never with heldThrough, never for another source, never a held preliminary day for rnl.
		expect(req({ heldThrough: '2026-01-02', cells: { cells: [[1600, 4100]], plan: '000' } })).toBe(false);
		expect(req({ source: 'chirps_gefs', cells: { cells: [[1600, 4100]], plan: '000' } })).toBe(false);
		expect(req({ config: { ...grid, product: 'rnl' }, cells: { cells: [[1600, 4100]], plan: '012' } })).toBe(false);
		expect(req({ config: { ...grid, product: 'rnl' }, cells: { cells: [[1600, 4100]], plan: '011' } })).toBe(true);
	});

	it('the answer’s shape: one row of values per cell, a value on exactly the days read, no preliminary rnl, no value past 2000 mm', () => {
		const answer = (over: Record<string, unknown>) => ({
			ok: true,
			cells: { product: 'sat', startDate: '2026-01-01', read: 'fp-', cells: [[1600, 4100]], values: [[0, 1065353216, null]], ...over },
			meta: {}
		});
		const ok = (over: Record<string, unknown>) => CellsResultSchema.safeParse(answer(over)).success;
		expect(ok({})).toBe(true);
		expect(ok({ values: [[-1, -1, null]] })).toBe(true);
		expect(ok({ values: [[0, null, null]] })).toBe(false);
		expect(ok({ values: [[0, 1, 2]] })).toBe(false);
		expect(ok({ values: [[0, 1]] })).toBe(false);
		expect(ok({ values: [] })).toBe(false);
		expect(ok({ values: [[0, CELL_VALUE_MAX_BITS + 1, null]] })).toBe(false);
		expect(ok({ values: [[0, -2, null]] })).toBe(false);
		expect(ok({ values: [[0, 1.5, null]] })).toBe(false);
		expect(ok({ product: 'rnl' })).toBe(false);
		expect(ok({ product: 'rnl', read: 'ff-' })).toBe(true);
		expect(ok({ cells: [[1600, 4100], [1600, 4100]], values: [[0, 1, null], [0, 1, null]] })).toBe(false);
		expect(ok({ read: 'fx-' })).toBe(false);
		// The fetcher's sat answer can't claim a value is final for the worker: there is no such field.
		expect(CellsResultSchema.safeParse({ ...answer({}), startDate: '2026-01-01' }).success).toBe(false);
	});

	it('the largest answer a fetch can give (100 cells × 120 days, every value ten digits) fits an SQS message with its envelope and the largest meta', () => {
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'k'.repeat(38)}`, 'k'.repeat(100)]));
		const result = {
			ok: true as const,
			cells: {
				product: 'sat' as const,
				startDate: '2026-01-01',
				read: 'p'.repeat(CHIRPS_MAX_DAYS),
				cells: Array.from({ length: 100 }, (_, i): [number, number] => [1600 + (i % 25), 4100 + Math.floor(i / 25)]),
				values: Array.from({ length: 100 }, () => new Array(CHIRPS_MAX_DAYS).fill(CELL_VALUE_MAX_BITS))
			},
			meta
		};
		expect(CellsResultSchema.safeParse(result).success).toBe(true);
		const message = { v: 1, type: 'ingest', fetchJobId: '00000000-0000-4000-8000-000000000000', feedId: '00000000-0000-4000-8000-000000000000', feedVersion: 'x'.repeat(40), result };
		const bytes = Buffer.byteLength(JSON.stringify(message));
		expect(bytes).toBeLessThan(MAX_MESSAGE_BYTES * 0.6);
	});

	it('with every tag and the largest re-check (40 files HEADed, 10 days read again at 100 cells), it still fits', () => {
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'k'.repeat(38)}`, 'k'.repeat(100)]));
		const tag = `"${'t'.repeat(FILE_TAG_MAX - 2)}"`;
		const day = (i: number) => fromEpochDay(toEpochDay('2020-01-01') + i);
		const result = {
			ok: true as const,
			cells: {
				product: 'sat' as const,
				startDate: '2026-01-01',
				read: 'f'.repeat(CHIRPS_MAX_DAYS),
				cells: Array.from({ length: 100 }, (_, i): [number, number] => [1600 + (i % 25), 4100 + Math.floor(i / 25)]),
				values: Array.from({ length: 100 }, () => new Array(CHIRPS_MAX_DAYS).fill(CELL_VALUE_MAX_BITS)),
				tags: new Array(CHIRPS_MAX_DAYS).fill(tag)
			},
			recheck: {
				head: Array.from({ length: RECHECK_HEAD_DAYS }, (_, i) => ({ day: day(i), tag })),
				read: Array.from({ length: RECHECK_READ_DAYS }, (_, i) => ({ day: day(100 + i), tag, values: new Array(100).fill(CELL_VALUE_MAX_BITS) }))
			},
			meta
		};
		expect(CellsResultSchema.safeParse(result).success).toBe(true);
		const message = { v: 1, type: 'ingest', fetchJobId: '00000000-0000-4000-8000-000000000000', feedId: '00000000-0000-4000-8000-000000000000', feedVersion: 'x'.repeat(40), result };
		expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(MAX_MESSAGE_BYTES * 0.75);
	});
});

describe('the re-check of cached finals (210_chirps_final_recheck)', () => {
	const today = '2026-03-10';
	const base = { source: 'chirps', config: grid, start: '2026-03-09', end: '2026-03-09', today, cells: { cells: [[1600, 4100]], plan: '1' } };
	const req = (recheck: unknown, over: Record<string, unknown> = {}) => FetchRequestSchema.safeParse({ ...base, ...over, recheck }).success;

	it('the request: with a cell-cache plan only, final files the product has by today, each day once in order, within the bounds', () => {
		const rc = { cells: [[1600, 4100]], head: ['2024-01-01', '2024-01-02'], read: ['2024-02-01'] };
		expect(req(rc)).toBe(true);
		expect(req(rc, { cells: undefined })).toBe(false);
		expect(req({ ...rc, head: ['2024-01-02', '2024-01-01'] })).toBe(false);
		expect(req({ ...rc, read: ['2024-01-01'] })).toBe(false);
		// sat begins in 1998, rnl in 1981; nothing after today.
		expect(req({ ...rc, head: ['1997-12-31'] })).toBe(false);
		expect(req({ ...rc, head: ['1990-01-01'] }, { config: { ...grid, product: 'rnl' } })).toBe(true);
		expect(req({ ...rc, read: ['2026-03-11'] })).toBe(false);
		expect(req({ ...rc, head: Array.from({ length: RECHECK_HEAD_DAYS + 1 }, (_, i) => fromEpochDay(toEpochDay('2020-01-01') + i)) })).toBe(false);
		expect(req({ ...rc, read: Array.from({ length: RECHECK_READ_DAYS + 1 }, (_, i) => fromEpochDay(toEpochDay('2020-01-01') + i)) })).toBe(false);
		expect(req({ ...rc, cells: [] })).toBe(false);
		expect(req({ ...rc, extra: 1 })).toBe(false);
	});

	it('the answer: tags only on final days, a re-check read with a value per cell or none, never a tag for a gone file', () => {
		const answer = (cells: Record<string, unknown>, recheck?: unknown) => ({
			ok: true,
			cells: { product: 'sat', startDate: '2026-01-01', read: 'fp-', cells: [[1600, 4100]], values: [[0, 1, null]], ...cells },
			...(recheck === undefined ? {} : { recheck }),
			meta: {}
		});
		const ok = (cells: Record<string, unknown>, recheck?: unknown) => CellsResultSchema.safeParse(answer(cells, recheck)).success;
		expect(ok({ tags: ['"a"', null, null] })).toBe(true);
		expect(ok({ tags: ['"a"', '"b"', null] })).toBe(false);
		expect(ok({ tags: ['"a"', null] })).toBe(false);
		expect(ok({ tags: ['bad\ttag', null, null] })).toBe(false);
		const rc = { head: [{ day: '2024-01-01', tag: '"x"' }], read: [{ day: '2024-01-02', tag: '"y"', values: [0, -1] }] };
		expect(ok({}, rc)).toBe(true);
		expect(ok({}, { ...rc, read: [{ day: '2024-01-02', tag: null, values: null }] })).toBe(true);
		expect(ok({}, { ...rc, read: [{ day: '2024-01-02', tag: '"y"', values: null }] })).toBe(false);
		expect(ok({}, { ...rc, read: [{ day: '2024-01-02', tag: '"y"', values: [null] }] })).toBe(false);
		expect(ok({}, { ...rc, read: [{ day: '2024-01-02', tag: '"y"', values: [CELL_VALUE_MAX_BITS + 1] }] })).toBe(false);
		expect(ok({}, { ...rc, head: [rc.head[0], rc.head[0]] })).toBe(false);
	});

	it('runFetch answers it from the files: HEADs give the tags, reads give each cell’s value and the tag, with the window read as before', async () => {
		const http = fixtureHttp(() => today);
		const day = '2025-06-01';
		const r = await runCells({ ...base, recheck: { cells: [[1600, 4100]], head: ['2025-05-01'], read: [day] } } as never, http);
		expect(r.cells.read).toBe('-');
		const tagOf = async (d: string) => (await http.head!(chirpsFinalUrl(d)))!.tag;
		expect(r.recheck!.head).toEqual([{ day: '2025-05-01', tag: await tagOf('2025-05-01') }]);
		expect(r.recheck!.read).toHaveLength(1);
		expect(r.recheck!.read[0]).toMatchObject({ day, tag: await tagOf(day) });
		expect(r.meta).toMatchObject({ filesChecked: 1, recheckDaysRead: 1 });
		// A HEAD or a read that fails is left out and counted; the feed's own fetch still answers.
		const broken = { ...http, head: async () => Promise.reject(new Error('HTTP 405')) };
		const f = await runCells({ ...base, recheck: { cells: [[1600, 4100]], head: ['2025-05-01'], read: [day] } } as never, broken);
		expect(f.ok).toBe(true);
		expect(f.recheck!.head).toEqual([]);
		expect(f.recheck!.read).toHaveLength(1);
		expect(f.meta).toMatchObject({ filesChecked: 0, recheckDaysRead: 1, recheckFailed: 1 });
		// A window's final days carry their files' tags, its preliminary days none.
		const w = await runCells({ ...base, start: '2026-01-29', end: '2026-01-30', cells: { cells: [[1600, 4100]], plan: '00' } } as never, http);
		expect(w.cells.read).toBe('fp');
		expect(w.cells.tags).toEqual([await tagOf('2026-01-29'), null]);
	});
});
