import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureHttp } from './fixtures.js';
import { DWS_MAX_YEARS } from './sources/dws.js';
import type { FeedHttp } from './http.js';
import {
	CHIRPS_FIRST_DAYS,
	CHIRPS_MAX_DAYS,
	CHIRPS_REVISION_DAYS,
	FEED_META_MAX_BYTES,
	FetchRequestSchema,
	FetchResult,
	fetchWindow,
	heldThrough,
	runFetch,
	utcToday
} from './fetch.js';

const grid = { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] };
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

	// What the marker and the held days save, on the fixtures (sat final up to
	// 40 days back, preliminary to 3; rnl final to 6): the range requests of a
	// caught-up feed's daily fetch without either, and with both (#69). Before
	// #69 the same fetch took 194 (sat) and 158 (rnl): every day probed its
	// final file and re-read its preliminary one.
	it.each([
		['sat', 160, 3],
		['rnl', 158, 5]
	] as const)('a caught-up %s feed’s daily fetch: %i range requests without them, %i with them', async (product, before, after) => {
		const day = '2026-03-10';
		const fixtures = fixtureHttp(() => day);
		let n = 0;
		const http: FeedHttp = { range: (u, s, e) => (n++, fixtures.range(u, s, e)), text: fixtures.text };
		const config = { ...grid, product };
		const first = fetchWindow('chirps', config, null, day);
		const r = await runFetch({ source: 'chirps', config, ...first, today: day }, http);
		if (!r.ok || r.startDate === null) throw new Error('the first fetch read nothing');
		const newest = new Date(Date.parse(`${r.startDate}T00:00:00Z`) + (r.values.length - 1) * 86_400_000).toISOString().slice(0, 10);
		expect(r.meta.finalThrough).toBe(product === 'sat' ? '2026-01-29' : '2026-03-04');
		const count = async (finalThrough: string | null, held: boolean) => {
			n = 0;
			const w = fetchWindow('chirps', config, newest, day, first.end, finalThrough);
			// Every day after the marker is still in the window, through yesterday: nothing the re-read could revise is skipped.
			expect(w.end).toBe(first.end);
			if (finalThrough) expect(w.start).toBe(new Date(Date.parse(`${finalThrough}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
			const h = held ? heldThrough('chirps', newest, w) : undefined;
			const again = await runFetch({ source: 'chirps', config, ...w, today: day, ...(h ? { heldThrough: h } : {}) }, http);
			// The feed card's preliminary count is the same either way.
			expect(again.ok ? (again.meta.prelimDays ?? 0) : null).toBe(product === 'sat' ? 37 : 0);
			return n;
		};
		expect(await count(null, false)).toBe(before);
		expect(await count(r.meta.finalThrough as string, true)).toBe(after);
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

	it('CHIRPS: how far the leading days are final (finalThrough), and none when the first day is preliminary', async () => {
		const r = await runFetch({ source: 'chirps', config: grid, start: '2026-01-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(r).toMatchObject({ ok: true, meta: { finalThrough: '2026-01-29', prelimDays: 37 } });
		const prelim = await runFetch({ source: 'chirps', config: grid, start: '2026-02-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(prelim.ok && prelim.meta).not.toHaveProperty('finalThrough');
		const rnl = await runFetch({ source: 'chirps', config: { ...grid, product: 'rnl' }, start: '2026-02-20', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(rnl).toMatchObject({ ok: true, meta: { finalThrough: '2026-03-04', prelimDays: 0 } });
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

	// A queue message: heldThrough only ever names a CHIRPS day inside the window (heldThrough()).
	it('takes heldThrough only as a CHIRPS day inside the window', () => {
		const req = (source: string, config: unknown, held: unknown) =>
			FetchRequestSchema.safeParse({ source, config, start: '2026-01-01', end: '2026-01-31', today: '2026-02-01', heldThrough: held }).success;
		expect(req('chirps', grid, '2026-01-01')).toBe(true);
		expect(req('chirps', grid, '2026-01-31')).toBe(true);
		expect(req('chirps', grid, undefined)).toBe(true);
		for (const bad of ['2025-12-31', '2026-02-01', '2026-02-30', 'soon', 7, null]) expect(req('chirps', grid, bad), String(bad)).toBe(false);
		expect(req('dws', { station: 'X0H000' }, '2026-01-10')).toBe(false);
		expect(req('chirps_gefs', grid, '2026-01-10')).toBe(false);
	});

	it('heldThrough() is the feed’s newest day bounded to the window, CHIRPS only', () => {
		const w = { start: '2026-01-10', end: '2026-01-20' };
		expect(heldThrough('chirps', '2026-01-15', w)).toBe('2026-01-15');
		expect(heldThrough('chirps', '2026-01-25', w)).toBe('2026-01-20');
		expect(heldThrough('chirps', '2026-01-09', w)).toBeUndefined();
		expect(heldThrough('chirps', null, w)).toBeUndefined();
		expect(heldThrough('chirps', '2026-01-15', { start: '2026-02-01', end: '2026-01-20' })).toBeUndefined();
		expect(heldThrough('dws', '2026-01-15', w)).toBeUndefined();
	});

	it('every window fetchWindow asks for passes (positive control)', () => {
		const today = '2026-06-01';
		for (const last of [null, '2026-05-28', '2020-01-01', '1990-01-01']) {
			for (const [source, config] of [['chirps', { ...grid, startDate: '1990-01-01' }], ['chirps', grid], ['chirps_gefs', grid], ['dws', { station: 'X0H000', startDate: '1950-01-01' }], ['dws', { station: 'X0H000' }]] as const) {
				for (const through of [null, '2026-05-31', '2020-03-01', '1995-01-01', '1970-12-31']) {
					for (const final of [null, '2026-05-31', '2026-05-01', '2020-03-01', '1995-01-01']) {
						const w = fetchWindow(source, config as never, last, today, through, final);
						const held = heldThrough(source, last, w);
						expect(FetchRequestSchema.safeParse({ source, config, ...w, today, ...(held ? { heldThrough: held } : {}) }).success, `${source} ${last} ${through} ${final}`).toBe(true);
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
