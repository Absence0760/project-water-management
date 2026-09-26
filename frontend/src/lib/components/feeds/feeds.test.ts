import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import { describePlace, describeTarget, describeTimes, draftToBody, emptyDraft, errorText, feedsApi, healthMessage, needsAttention, parseCells } from './feeds';

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

describe('draftToBody', () => {
	it('grid sources send cells; DWS sends an upper-cased station', () => {
		expect(draftToBody({ ...emptyDraft('chirps', ['rain_chirps_mm']), cells: '-20.12, 25.17', targetName: ' Upper ' })).toEqual({
			body: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, targetKind: 'rain_chirps_mm', targetName: 'Upper', schedule: 'daily' }
		});
		expect(draftToBody({ ...emptyDraft('dws', ['flow_observed_m3s']), station: ' x0h000 ' })).toMatchObject({ body: { config: { station: 'X0H000' } } });
	});

	it('explains a bad station or cells', () => {
		expect(draftToBody({ ...emptyDraft('dws'), station: 'X0H00' })).toEqual({ error: expect.stringMatching(/looks like A2H012/) });
		expect(draftToBody({ ...emptyDraft('chirps_gefs'), cells: '' })).toEqual({ error: expect.stringMatching(/at least one/) });
	});
});

describe('descriptions', () => {
	it('say where a feed reads and what it writes', () => {
		expect(describePlace({ source: 'dws', config: { station: 'X0H000' } })).toBe('station X0H000');
		expect(describePlace({ source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } })).toBe('cell -20.12, 25.17');
		expect(describePlace({ source: 'chirps', config: { cells: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] } })).toBe('2 cells');
		expect(describeTarget({ targetKind: 'rain_forecast_mm', targetName: '' })).toBe('Rainfall — forecast');
		expect(describeTarget({ targetKind: 'flow_observed_m3s', targetName: 'Weir' })).toBe('Flow — observed gauge · Weir');
	});

	it('say when data last arrived as a calendar day, whatever the time zone', () => {
		expect(describeTimes({ lastDataDate: '2026-09-21', lastAttemptAt: null })).toBe('Last data 21 Sep 2026 · not checked yet');
		expect(describeTimes({ lastDataDate: null, lastAttemptAt: '2026-09-24T06:00:00Z' })).toMatch(/^No data yet · checked 2026-09-2\d \d\d:\d\d$/);
	});

	it('write the health sentence’s calendar days as "1 Sep 2026", leaving other numbers alone', () => {
		// The shapes backend/src/feeds/health.ts produces.
		expect(healthMessage('OK; newest data 2026-10-10, checked 2026-09-25.')).toBe('OK; newest data 10 Oct 2026, checked 25 Sep 2026.');
		expect(healthMessage('The last 2 fetches failed: the source is unreachable: HTTP 503. Newest data 2026-09-01.')).toBe(
			'The last 2 fetches failed: the source is unreachable: HTTP 503. Newest data 1 Sep 2026.'
		);
		expect(healthMessage('No new data: the newest day, 2026-01-31, is more than 240 days old.')).toBe('No new data: the newest day, 31 Jan 2026, is more than 240 days old.');
		expect(healthMessage('Switched off; no data yet.')).toBe('Switched off; no data yet.');
		expect(healthMessage('the grid has no data at -20.27, 25.37')).toBe('the grid has no data at -20.27, 25.37');
		expect(healthMessage('at 2026-09-24T06:00:00Z')).toBe('at 2026-09-24T06:00:00Z');
	});

	it('count the feeds that need attention', () => {
		const h = (state: string) => ({ health: { state, stale: false, staleAfterDays: 1, message: '' } }) as never;
		expect(needsAttention([h('ok'), h('stale'), h('failing'), h('pending'), h('disabled')])).toBe(2);
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
