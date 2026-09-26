import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureHttp } from './fixtures.js';
import { DWS_MAX_YEARS } from './sources/dws.js';
import type { FeedHttp } from './http.js';
import {
	CHIRPS_FIRST_DAYS,
	CHIRPS_MAX_DAYS,
	CHIRPS_REVISION_DAYS,
	FETCH_META_MAX_BYTES,
	FetchRequestSchema,
	FetchResult,
	fetchWindow,
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

	it('CHIRPS with nothing published yet: ok, no days', async () => {
		const r = await runFetch({ source: 'chirps', config: grid, start: '2026-03-09', end: '2026-03-09', today: '2026-03-10' }, http);
		expect(r).toEqual({ ok: true, startDate: null, values: [], meta: { days: 0 } });
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
		['a huge error', { ok: false, error: 'x'.repeat(501) }]
	])('refuses %s', (_, value) => {
		expect(FetchResult.safeParse(value).success).toBe(false);
	});

	it('accepts a result with gaps, and an empty one', () => {
		expect(FetchResult.safeParse({ ok: true, startDate: '2026-01-01', values: [1, null, 0], meta: { days: 3 } }).success).toBe(true);
		expect(FetchResult.safeParse({ ok: true, startDate: null, values: [], meta: {} }).success).toBe(true);
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

	it('every window fetchWindow asks for passes (positive control)', () => {
		const today = '2026-06-01';
		for (const last of [null, '2026-05-28', '2020-01-01', '1990-01-01']) {
			for (const [source, config] of [['chirps', { ...grid, startDate: '1990-01-01' }], ['chirps', grid], ['chirps_gefs', grid], ['dws', { station: 'X0H000', startDate: '1950-01-01' }], ['dws', { station: 'X0H000' }]] as const) {
				const w = fetchWindow(source, config as never, last, today);
				expect(FetchRequestSchema.safeParse({ source, config, ...w, today }).success, `${source} ${last}`).toBe(true);
			}
		}
	});
});

describe('FetchResult meta fits its column (018_feeds.sql: 4 KB of JSON)', () => {
	it('refuses meta over FETCH_META_MAX_BYTES of UTF-8 JSON, even within the key and length limits', () => {
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'é'.repeat(38)}`, 'é'.repeat(100)]));
		expect(FetchResult.safeParse({ ok: true, startDate: '2026-01-01', values: [1], meta }).success).toBe(false);
		expect(FETCH_META_MAX_BYTES).toBeLessThan(4096);
	});
});
