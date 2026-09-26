import { afterEach, describe, expect, it } from 'vitest';
import { feedHealth, type HealthInput } from './health.js';

const base: HealthInput = {
	source: 'chirps',
	config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] },
	enabled: true,
	createdAt: '2026-09-01T08:00:00Z',
	lastAttemptAt: '2026-09-24T06:00:00Z',
	lastSuccessAt: '2026-09-24T06:00:00Z',
	lastDataDate: '2026-09-20',
	consecutiveFailures: 0,
	lastError: null
};
const today = '2026-09-25';

// Rule 7: dates judged in a zone far from UTC must still count UTC days.
const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

describe('feedHealth', () => {
	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('ok: fetched, recent data (TZ %s)', (zone) => {
		process.env.TZ = zone;
		expect(feedHealth(base, today)).toEqual({ state: 'ok', stale: false, staleAfterDays: 12, message: 'OK; newest data 2026-09-20, checked 2026-09-24.' });
		// Timestamps as Date objects (straight from pg) read the same.
		expect(feedHealth({ ...base, lastSuccessAt: new Date('2026-09-24T23:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') }, today).message).toBe(
			'OK; newest data 2026-09-20, checked 2026-09-24.'
		);
	});

	it('stale: CHIRPS newer than 12 days is fine, older is stale', () => {
		expect(feedHealth({ ...base, lastDataDate: '2026-09-13' }, today).state).toBe('ok');
		const h = feedHealth({ ...base, lastDataDate: '2026-09-12' }, today);
		expect(h).toMatchObject({ state: 'stale', stale: true });
		expect(h.message).toBe('No new data: the newest day, 2026-09-12, is more than 12 days old.');
	});

	it('stale: a forecast that reaches less than 12 days ahead', () => {
		const gefs = { ...base, source: 'chirps_gefs' as const };
		expect(feedHealth({ ...gefs, lastDataDate: '2026-10-09' }, today).state).toBe('ok');
		expect(feedHealth({ ...gefs, lastDataDate: '2026-10-06' }, today)).toMatchObject({
			state: 'stale',
			message: 'No new forecast: it reaches only 2026-10-06, less than 12 days ahead.'
		});
	});

	it('stale: DWS allows months of lag, and a feed’s own staleAfterDays wins', () => {
		const dws = { ...base, source: 'dws' as const, config: { station: 'X0H000' } };
		expect(feedHealth({ ...dws, lastDataDate: '2026-03-01' }, today).state).toBe('ok');
		expect(feedHealth({ ...dws, lastDataDate: '2025-12-01' }, today).state).toBe('stale');
		expect(feedHealth({ ...dws, config: { station: 'X0H000', staleAfterDays: 400 }, lastDataDate: '2025-12-01' }, today)).toMatchObject({ state: 'ok', staleAfterDays: 400 });
	});

	it('failing wins over stale, and says both what failed and how old the data is', () => {
		const h = feedHealth({ ...base, consecutiveFailures: 3, lastError: 'the source is unreachable: HTTP 503', lastDataDate: '2026-09-01' }, today);
		expect(h).toEqual({
			state: 'failing',
			stale: true,
			staleAfterDays: 12,
			message: 'The last 3 fetches failed: the source is unreachable: HTTP 503. Newest data 2026-09-01.'
		});
		expect(feedHealth({ ...base, consecutiveFailures: 1, lastError: 'x' }, today).message).toBe('The last fetch failed: x. Newest data 2026-09-20.');
	});

	it('pending: never fetched, just attached', () => {
		expect(feedHealth({ ...base, createdAt: '2026-09-24T10:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null }, today)).toEqual({
			state: 'pending',
			stale: false,
			staleAfterDays: 12,
			message: 'Waiting for its first fetch.'
		});
	});

	it('stale: never fetched days after it was attached (is the worker running?), or fetching but finding nothing', () => {
		const never = { ...base, createdAt: '2026-09-20T10:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null };
		expect(feedHealth(never, today)).toMatchObject({ state: 'stale', message: expect.stringMatching(/worker may not be running/) });
		const empty = { ...never, lastAttemptAt: '2026-09-24T06:00:00Z', lastSuccessAt: '2026-09-24T06:00:00Z' };
		expect(feedHealth(empty, today)).toMatchObject({ state: 'stale', message: 'Fetches succeed but have found no data yet: check the cells or station.' });
	});

	it('pending again after a new place or series is saved: the old fetches say nothing about it', () => {
		// 018_feeds.sql clears the data, success and failures on a re-target, but keeps last_attempt_at.
		const retargeted = { ...base, updatedAt: '2026-09-25T09:00:00Z', lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 0 };
		expect(feedHealth(retargeted, today)).toEqual({ state: 'pending', stale: false, staleAfterDays: 12, message: 'Waiting for its first fetch.' });
		// Still unfetched two days on: the worker may not be running, counted from the save.
		expect(feedHealth(retargeted, '2026-09-28')).toMatchObject({
			state: 'stale',
			message: 'Not fetched since it was changed on 2026-09-25: the background worker may not be running.'
		});
		// Fetched since, finding nothing: the usual message.
		expect(feedHealth({ ...retargeted, lastAttemptAt: '2026-09-25T09:05:00Z', lastSuccessAt: '2026-09-25T09:05:00Z' }, today)).toMatchObject({
			state: 'ok',
			message: 'OK; no data yet, checked 2026-09-25.'
		});
		// A plain save (same place and series) keeps the data, so the data decides.
		expect(feedHealth({ ...base, updatedAt: '2026-09-25T09:00:00Z' }, today).state).toBe('ok');
	});

	it('disabled, whatever else', () => {
		expect(feedHealth({ ...base, enabled: false, consecutiveFailures: 2 }, today)).toMatchObject({ state: 'disabled', message: 'Switched off; newest data 2026-09-20.' });
	});
});
