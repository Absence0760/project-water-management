import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import {
	targetHint,
	conflictMessage,
	describePlace,
	describeWrites,
	feedWrites,
	versionClash,
	describeRunsAs,
	describeTarget,
	describeTimes,
	draftToBody,
	emptyDraft,
	errorText,
	type FeedHealth,
	feedsApi,
	type FeedState,
	type HealthReason,
	healthMessage,
	keptNote,
	needsAttention,
	parseBbox,
	parseCells,
	separateName,
	takeoverOf
} from './feeds';

describe('parseCells', () => {
	it('reads one cell per line (or ;), with an optional weight', () => {
		expect(parseCells('-20.12, 25.17')).toEqual({ cells: [{ lat: -20.12, lon: 25.17 }] });
		expect(parseCells(' -20.12 25.17 \n\n-20.2,25.3,2')).toEqual({ cells: [{ lat: -20.12, lon: 25.17 }, { lat: -20.2, lon: 25.3, weight: 2 }] });
		expect(parseCells('1,2; 3,4')).toEqual({ cells: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] });
	});

	it('reads the typeset minus sign the sample-grid hint uses, so a copied value parses', () => {
		expect(parseCells('\u221220.12, 25.17')).toEqual({ cells: [{ lat: -20.12, lon: 25.17 }] });
	});

	it('takes a weight up to the server’s cap of 1000', () => {
		expect(parseCells('0, 1, 1000')).toEqual({ cells: [{ lat: 0, lon: 1, weight: 1000 }] });
	});

	it.each([
		['', /at least one grid cell/],
		['-20.12', /Cell 1 .* should be/],
		['a, b', /should be/],
		['1,2,3,4', /should be/],
		['61, 25', /latitude must be between -60 and 60/],
		['0, 181', /longitude must be between/],
		['0, 1, 0', /weight must be above 0 and at most 1000/],
		['0, 1, 1001', /weight must be above 0 and at most 1000/],
		[Array.from({ length: 26 }, () => '1,2').join('\n'), /At most 25/]
	])('refuses %j', (text, message) => {
		const r = parseCells(text);
		expect('error' in r && r.error).toMatch(message);
	});
});

describe('parseBbox', () => {
	it('reads “south, west, north, east”, with commas or spaces, and a typeset minus', () => {
		const box = { south: -20.3, west: 25, north: -20.1, east: 25.2 };
		expect(parseBbox('-20.3, 25, -20.1, 25.2')).toEqual({ bbox: box });
		expect(parseBbox(' \u221220.3 25 \u221220.1   25.2 ')).toEqual({ bbox: box });
	});

	it.each([
		['', /Enter the bounding box/],
		['-20.3, 25, -20.1', /four numbers/],
		['-20.3, 25, -20.1, 25.2, 1', /four numbers/],
		['-20.3, 25, north, 25.2', /four numbers/],
		['-61, 25, -20.1, 25.2', /latitudes must be between -60 and 60/],
		['-20.3, 181, -20.1, 25.2', /longitudes must be between -180 and 180/],
		['-20.1, 25, -20.3, 25.2', /south edge must be below the north edge/],
		['-20.3, 25.2, -20.1, 25.2', /can’t cross 180°/],
		['-20.3, 179.9, -20.1, -179.9', /can’t cross 180°/]
	])('explains “%s”', (text, message) => {
		expect(parseBbox(text)).toEqual({ error: expect.stringMatching(message) });
	});

	it('mirrors the server’s limits: 100 cells, 25 rows; an edge on a grid line adds no cell', () => {
		// 10 × 10 cells on grid lines (−20.5 / 0.05 isn’t exact in floating point): allowed.
		expect(parseBbox('-20.5, 25, -20, 25.5')).toHaveProperty('bbox');
		// 25 rows × 4 columns: allowed; 26 rows: refused.
		expect(parseBbox('-21.25, 25, -20, 25.2')).toHaveProperty('bbox');
		expect(parseBbox('-21.3, 25, -20, 25.05')).toEqual({ error: expect.stringMatching(/covers 26 grid cells in 26 rows; at most 100 cells in 25 rows/) });
		expect(parseBbox('-21, 25, -20, 26')).toEqual({ error: expect.stringMatching(/covers 400 grid cells in 20 rows.*about 0\.5° × 0\.5°.*list cells instead/) });
		// Inside one cell.
		expect(parseBbox('-20.14, 25.16, -20.11, 25.19')).toHaveProperty('bbox');
	});
});

describe('draftToBody', () => {
	it('a grid source with a bounding box sends { bbox } (and CHIRPS its product and start date); a bad box points at its field', () => {
		const box = { ...emptyDraft('chirps', ['rain_chirps_mm']), area: 'bbox' as const, bbox: '-20.3, 25, -20.1, 25.2', cells: 'ignored' };
		expect(draftToBody(box)).toEqual({
			body: { source: 'chirps', config: { bbox: { south: -20.3, west: 25, north: -20.1, east: 25.2 } }, targetKind: 'rain_chirps_mm', targetName: '', schedule: 'daily' }
		});
		expect(draftToBody({ ...box, product: 'rnl', startDate: '1985-01-01' })).toMatchObject({ body: { config: { bbox: { south: -20.3 }, product: 'rnl', startDate: '1985-01-01' } } });
		expect(draftToBody({ ...box, source: 'chirps_gefs' })).toMatchObject({ body: { config: { bbox: { south: -20.3, west: 25, north: -20.1, east: 25.2 } } } });
		expect(draftToBody({ ...box, bbox: '-20.1, 25, -20.3, 25.2' })).toEqual({ error: expect.stringMatching(/south edge/), field: 'bbox' });
		// Leaving out sea cells: sent only when ticked, and only with a box (listed cells stay strict).
		expect(draftToBody({ ...box, skipNoData: true })).toMatchObject({ body: { config: { bbox: { south: -20.3 }, skipNoData: true } } });
		expect((draftToBody(box) as { body: { config: object } }).body.config).not.toHaveProperty('skipNoData');
		expect((draftToBody({ ...box, area: 'cells', cells: '-20.12, 25.17', skipNoData: true }) as { body: { config: object } }).body.config).not.toHaveProperty('skipNoData');
	});


	it('grid sources send cells; DWS sends an upper-cased station', () => {
		expect(draftToBody({ ...emptyDraft('chirps', ['rain_chirps_mm']), cells: '-20.12, 25.17', targetName: ' Upper ' })).toEqual({
			body: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, targetKind: 'rain_chirps_mm', targetName: 'Upper', schedule: 'daily' }
		});
		expect(draftToBody({ ...emptyDraft('dws', ['flow_observed_m3s']), station: ' x0h000 ' })).toMatchObject({ body: { config: { station: 'X0H000' } } });
	});

	it('explains a bad station or cells', () => {
		expect(draftToBody({ ...emptyDraft('dws'), station: 'X0H00' })).toEqual({ error: expect.stringMatching(/looks like A2H012/), field: 'station' });
		expect(draftToBody({ ...emptyDraft('dws'), station: 'x0r000' })).toEqual({ error: expect.stringMatching(/river gauge.*H code/), field: 'station' });
		expect(draftToBody({ ...emptyDraft('chirps_gefs'), cells: '' })).toEqual({ error: expect.stringMatching(/at least one/), field: 'cells' });
	});

	// Issue #40c: one CHIRPS v3 daily product end to end, from no earlier than its first day.
	it('CHIRPS sends its daily product (rnl only: sat is the default) and an optional start date the product covers', () => {
		const chirps = { ...emptyDraft('chirps', ['rain_chirps_mm']), cells: '-20.12, 25.17' };
		expect(draftToBody({ ...chirps, product: 'rnl', startDate: '1985-01-01' })).toMatchObject({ body: { config: { cells: [{ lat: -20.12, lon: 25.17 }], product: 'rnl', startDate: '1985-01-01' } } });
		expect(draftToBody({ ...chirps, startDate: '1998-01-01' })).toMatchObject({ body: { config: { startDate: '1998-01-01' } } });
		expect(draftToBody({ ...chirps, startDate: '1997-12-31' })).toEqual({ error: expect.stringMatching(/sat product begins on 1998-01-01\. For earlier days choose the rnl product/), field: 'start' });
		expect(draftToBody({ ...chirps, product: 'rnl', startDate: '1980-12-31' })).toEqual({ error: 'CHIRPS begins on 1981-01-01.', field: 'start' });
		expect(draftToBody({ ...chirps, startDate: '1 Jan 2020' })).toEqual({ error: expect.stringMatching(/YYYY-MM-DD/), field: 'start' });
		// The forecast has no product or start date field.
		expect(draftToBody({ ...emptyDraft('chirps_gefs'), cells: '-20.12, 25.17', product: 'rnl', startDate: '1985-01-01' })).toMatchObject({ body: { config: { cells: [{ lat: -20.12, lon: 25.17 }] } } });
		expect((draftToBody({ ...emptyDraft('chirps_gefs'), cells: '-20.12, 25.17' }) as { body: { config: object } }).body.config).not.toHaveProperty('product');
	});
});

describe('the CHIRPS version guard (issue #40c)', () => {
	const body = (product?: 'sat' | 'rnl') => ({ source: 'chirps' as const, config: { cells: [], ...(product ? { product } : {}) } });
	it('says what a feed writes', () => {
		expect(feedWrites('chirps')).toEqual({ product: 'CHIRPS sat', version: '3.0' });
		expect(feedWrites('chirps', 'rnl')).toEqual({ product: 'CHIRPS rnl', version: '3.0' });
		expect(feedWrites('dws')).toBeNull();
		expect(describeWrites({ writes: { product: 'CHIRPS sat', version: '3.0' } })).toBe(' · CHIRPS sat v3.0');
		expect(describeWrites({ writes: null })).toBe('');
	});

	it('finds a clash with a filled series of another product or version, or an unrecorded one', () => {
		const v2 = { length: 10, product: 'CHIRPS', productVersion: '2.0' };
		expect(versionClash(v2, body())).toEqual({ holds: 'CHIRPS v2.0', writes: 'CHIRPS sat v3.0' });
		expect(versionClash({ length: 10, product: null, productVersion: null }, body('rnl'))).toEqual({ holds: 'an unrecorded version', writes: 'CHIRPS rnl v3.0' });
		expect(versionClash({ length: 10, product: 'CHIRPS sat', productVersion: '3.0' }, body('rnl'))).toEqual({ holds: 'CHIRPS sat v3.0', writes: 'CHIRPS rnl v3.0' });
		// Positive controls: the same version, an empty or missing series, a source without versions.
		expect(versionClash({ length: 10, product: 'CHIRPS sat', productVersion: '3.0' }, body())).toBeNull();
		expect(versionClash({ ...v2, length: 0 }, body())).toBeNull();
		expect(versionClash(null, body())).toBeNull();
		expect(versionClash(v2, { source: 'dws', config: { station: 'X0H000' } })).toBeNull();
	});

	it('says how far a staged replacement has got, or that it stalled', () => {
		const h = (reason: HealthReason, state: FeedState = 'pending'): FeedHealth => ({ state, stale: false, staleAfterDays: 12, reason });
		expect(healthMessage(h({ code: 'rebuilding', from: '2001-01-01', through: '2001-04-30' }))).toBe(
			'Replacing the series: the new record runs 1 Jan 2001 to 30 Apr 2001 so far. The series stays as it is until the backfill completes.'
		);
		expect(healthMessage(h({ code: 'rebuild-stalled', from: '2001-01-01', through: '2001-04-30', since: '2026-09-23' }, 'stale'))).toMatch(
			/^The replacement stopped growing on 23 Sep 2026 .*withdraw the replacement\.$/
		);
	});

	it('tells the owner why a listed feed is refused, or that the replacement is waiting', () => {
		const f = { versionConflict: true, series: { filled: true, provenance: { product: 'CHIRPS', version: '2.0' } }, writes: { product: 'CHIRPS sat', version: '3.0' }, replaceFrom: null };
		expect(conflictMessage(f)).toMatch(/^The series holds CHIRPS v2\.0 and this feed writes CHIRPS sat v3\.0, so every fetch is refused/);
		expect(conflictMessage({ ...f, replaceFrom: 'CHIRPS/2.0' })).toMatch(
			/^Replacement confirmed: the feed backfills CHIRPS sat v3\.0 from its start date, then replaces the series \(CHIRPS v2\.0\) with it whole\. Until then runs use the series as it is/
		);
		expect(conflictMessage({ ...f, versionConflict: false })).toBeNull();
	});
});

describe('descriptions', () => {
	it('say where a feed reads and what it writes', () => {
		expect(describePlace({ source: 'dws', config: { station: 'X0H000' } })).toBe('station X0H000');
		expect(describePlace({ source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } })).toBe('cell -20.12, 25.17');
		expect(describePlace({ source: 'chirps', config: { cells: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] } })).toBe('2 cells');
		expect(describePlace({ source: 'chirps', config: { bbox: { south: -20.3, west: 25, north: -20.1, east: 25.2 } } })).toBe('box -20.30, 25.00 to -20.10, 25.20');
		expect(describePlace({ source: 'chirps_gefs', config: { bbox: { south: -20.125, west: 25.1, north: -20.1, east: 25.175 } } })).toBe('box -20.125, 25.10 to -20.10, 25.175');
		expect(describePlace({ source: 'chirps', config: { bbox: { south: -20.3, west: 25.3, north: -20.2, east: 25.4 }, skipNoData: true } })).toBe('box -20.30, 25.30 to -20.20, 25.40, sea cells left out');
		expect(describeTarget({ targetKind: 'rain_forecast_mm', targetName: '' })).toBe('Rainfall — forecast');
		expect(describeTarget({ targetKind: 'flow_observed_m3s', targetName: 'Weir' })).toBe('Flow — observed gauge · Weir');
	});

	it('say when data last arrived as a calendar day, whatever the time zone', () => {
		expect(describeTimes({ lastDataDate: '2026-09-21', lastAttemptAt: null })).toBe('Last data 21 Sep 2026 · not checked yet');
		expect(describeTimes({ lastDataDate: null, lastAttemptAt: '2026-09-24T06:00:00Z' })).toMatch(/^No data yet · checked 2026-09-2\d \d\d:\d\d$/);
	});

	describe('the health sentence, written from the server’s reason code with its days as "1 Sep 2026"', () => {
		// Rule 7: the days are calendar days and must not move with the viewer's zone.
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		const h = (reason: HealthReason, staleAfterDays = 12, state: FeedState = 'ok'): FeedHealth => ({ state, stale: false, staleAfterDays, reason });

		it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('for every code (TZ %s)', (zone) => {
			process.env.TZ = zone;
			expect(healthMessage(h({ code: 'ok', newest: '2026-10-10', checked: '2026-09-25' }))).toBe('OK; newest data 10 Oct 2026, checked 25 Sep 2026.');
			expect(healthMessage(h({ code: 'ok', newest: null, checked: '2026-09-01' }))).toBe('OK; no data yet, checked 1 Sep 2026.');
			expect(healthMessage(h({ code: 'failing', failures: 2, error: 'the source is unreachable: HTTP 503', newest: '2026-09-01' }))).toBe(
				'The last 2 fetches failed: the source is unreachable: HTTP 503. Newest data 1 Sep 2026.'
			);
			expect(healthMessage(h({ code: 'failing', failures: 1, error: null, newest: null }))).toBe('The last fetch failed: unknown error. No data yet.');
			// An error that reads like a date is the server's text, left as it is.
			expect(healthMessage(h({ code: 'failing', failures: 1, error: 'no data at 2026-09-24', newest: null }))).toBe('The last fetch failed: no data at 2026-09-24. No data yet.');
			expect(healthMessage(h({ code: 'old-data', newest: '2026-01-31' }, 240))).toBe('No new data: the newest day, 31 Jan 2026, is more than 240 days old.');
			expect(healthMessage(h({ code: 'old-forecast', newest: '2026-10-06' }, -12))).toBe('No new forecast: it reaches only 6 Oct 2026, less than 12 days ahead.');
			expect(healthMessage(h({ code: 'no-data' }))).toBe('Fetches succeed but have found no data yet: check the cells or station.');
			expect(healthMessage(h({ code: 'not-fetched', since: '2026-09-20', after: 'attached' }))).toBe('Not fetched since it was attached on 20 Sep 2026: the background worker may not be running.');
			expect(healthMessage(h({ code: 'not-fetched', since: '2026-09-25', after: 'changed' }))).toBe('Not fetched since it was changed on 25 Sep 2026: the background worker may not be running.');
			expect(healthMessage(h({ code: 'waiting' }))).toBe('Waiting for its first fetch.');
			expect(healthMessage(h({ code: 'off', newest: null }))).toBe('Switched off; no data yet.');
			expect(healthMessage(h({ code: 'off', newest: '2026-09-20' }))).toBe('Switched off; newest data 20 Sep 2026.');
		});

		it('falls back to the state for a code this client does not know (a newer server)', () => {
			expect(healthMessage(h({ code: 'something-new' } as never, 12, 'stale'))).toBe('Stale.');
		});
	});

	it('say who the fetches run as, and how to give an orphaned feed an owner again', () => {
		expect(describeRunsAs({ actingUser: 'Ann' })).toBe(' · runs as Ann');
		expect(describeRunsAs({ actingUser: null })).toMatch(/no acting owner: .*switches it off and on again/);
	});

	it('count the feeds that need attention', () => {
		const h = (state: string) => ({ health: { state, stale: false, staleAfterDays: 1, reason: { code: 'waiting' } } }) as never;
		expect(needsAttention([h('ok'), h('stale'), h('failing'), h('pending'), h('disabled')])).toBe(2);
	});
	it('say how many days the last fetch kept the user’s own values (last_meta.kept)', () => {
		expect(keptNote({ days: 60, merged: 58, kept: 2 })).toBe('2 days kept your own values');
		expect(keptNote({ kept: 1 })).toBe('1 day kept your own value');
		expect(keptNote({ kept: 0 })).toBeNull();
		expect(keptNote({ days: 3 })).toBeNull();
		expect(keptNote({ kept: 'x' })).toBeNull();
		expect(keptNote(null)).toBeNull();
	});
});

describe('taking over an existing series (issue #30)', () => {
	const s = (kind: string, name: string, length = 10) => ({ kind, name, length });
	const target = { targetKind: 'rain_catchment_mm', targetName: '' };

	it('finds the target series when it already holds data', () => {
		expect(takeoverOf([s('rain_chirps_mm', ''), s('rain_catchment_mm', '', 365)], [], target)).toEqual(s('rain_catchment_mm', '', 365));
		// Matched by kind and exact name.
		expect(takeoverOf([s('rain_catchment_mm', 'Gauge')], [], target)).toBeNull();
		expect(takeoverOf([s('rain_catchment_mm', 'Gauge')], [], { ...target, targetName: 'Gauge' })).toEqual(s('rain_catchment_mm', 'Gauge'));
	});

	it('is no takeover for a missing or empty series, or one another feed already writes (the server refuses that)', () => {
		expect(takeoverOf([], [], target)).toBeNull();
		expect(takeoverOf([s('rain_catchment_mm', '', 0)], [], target)).toBeNull();
		expect(takeoverOf([s('rain_catchment_mm', '')], [target], target)).toBeNull();
	});

	it('suggests a separate name no series or feed of that kind uses', () => {
		const chirps = { source: 'chirps' as const, config: { cells: [{ lat: 1, lon: 2 }] }, targetKind: 'rain_catchment_mm' };
		expect(separateName(chirps, [s('rain_catchment_mm', '')], [])).toBe('CHIRPS');
		// Another kind's "CHIRPS" is no clash; this kind's series and feed names are.
		expect(separateName(chirps, [s('rain_chirps_mm', 'CHIRPS')], [])).toBe('CHIRPS');
		expect(separateName(chirps, [s('rain_catchment_mm', 'CHIRPS')], [{ targetKind: 'rain_catchment_mm', targetName: 'CHIRPS 2' }])).toBe('CHIRPS 3');
		expect(separateName({ ...chirps, source: 'chirps_gefs' }, [], [])).toBe('CHIRPS-GEFS');
		expect(separateName({ source: 'dws', config: { station: 'A2H012' }, targetKind: 'flow_observed_m3s' }, [], [])).toBe('DWS A2H012');
	});
});

describe('feedsApi', () => {
	it('calls the feed routes under the project', async () => {
		const request = vi.fn(async (..._a: unknown[]) => ({ feed: { id: 'f' } }) as never);
		const f = feedsApi({ request } as never, 'p/1');
		await f.list();
		await f.create({ source: 'dws', config: { station: 'X0H000' }, targetKind: 'flow_observed_m3s', targetName: '', schedule: 'daily' });
		await f.update('f 1', { enabled: false });
		await f.remove('f1');
		await f.runNow('f1');
		expect(request.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
			'GET /projects/p%2F1/feeds',
			'POST /projects/p%2F1/feeds',
			'PATCH /projects/p%2F1/feeds/f%201',
			'DELETE /projects/p%2F1/feeds/f1',
			'POST /projects/p%2F1/feeds/f1/run-now'
		]);
	});
});

describe('errorText', () => {
	it('shows the server’s message with a capital, and never a raw script error', () => {
		expect(errorText(new ApiError(409, 'another feed already writes that series'))).toBe('Another feed already writes that series');
		expect(errorText(new ApiError(0, 'Could not reach the server'))).toBe('Could not reach the server');
		expect(errorText(new TypeError("Cannot read properties of undefined (reading 'feeds')"))).toBe('Something went wrong. Try again, or reload the page.');
		expect(errorText('boom')).toBe('Something went wrong. Try again, or reload the page.');
	});
});

describe('targetHint (issue #51)', () => {
	it('warns that CHIRPS into the catchment rain series is used raw; nothing for the usual targets', () => {
		expect(targetHint('chirps', 'rain_catchment_mm')).toMatch(/^CHIRPS becomes the catchment rain itself: used as published, with no bias correction/);
		expect(targetHint('chirps', 'rain_chirps_mm')).toBeNull();
		expect(targetHint('chirps_gefs', 'rain_forecast_mm')).toBeNull();
		expect(targetHint('dws', 'flow_observed_m3s')).toBeNull();
	});
});
