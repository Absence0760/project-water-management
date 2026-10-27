import { afterEach, describe, expect, it } from 'vitest';
import { COPY_FINAL_LAG_DAYS, COPY_PRELIM_LAG_DAYS, type CopyDays, copyBehind, feedHealth, type HealthInput, rainCopyStatus } from './health.js';

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

// Rule 7: the server's own zone never changes a day; only the zone passed in does.
const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

// The reason carries the days as plain YYYY-MM-DD fields (issue #36): the
// client writes the sentence and formats them, so no date is baked into text.
describe('feedHealth', () => {
	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('ok: fetched, recent data (TZ %s)', (zone) => {
		process.env.TZ = zone;
		expect(feedHealth(base, today, 'UTC')).toEqual({ state: 'ok', stale: false, staleAfterDays: 12, reason: { code: 'ok', newest: '2026-09-20', checked: '2026-09-24' } });
		// Timestamps as Date objects (straight from pg) read the same, as UTC days.
		expect(feedHealth({ ...base, lastSuccessAt: new Date('2026-09-24T23:30:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') }, today, 'UTC').reason).toEqual({
			code: 'ok',
			newest: '2026-09-20',
			checked: '2026-09-24'
		});
	});

	// The days a person reads are the project's (058), not UTC's or the
	// server's: 23:30 UTC is already the next day in South Africa. The source's
	// own day (newest) passes through as it is.
	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('dates what it reports in the project’s time zone (TZ %s)', (zone) => {
		process.env.TZ = zone;
		const late = { ...base, lastSuccessAt: new Date('2026-09-24T23:30:00Z'), lastAttemptAt: '2026-09-24T23:30:00Z' };
		expect(feedHealth(late, '2026-09-25', 'Africa/Johannesburg').reason).toEqual({ code: 'ok', newest: '2026-09-20', checked: '2026-09-25' });
		// Positive control: the same instant in a UTC project is the 24th.
		expect(feedHealth(late, '2026-09-25', 'UTC').reason).toEqual({ code: 'ok', newest: '2026-09-20', checked: '2026-09-24' });
		// A feed attached at 23:00 UTC on the 20th was attached on the 21st in South Africa.
		const never = { ...base, createdAt: '2026-09-20T23:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null };
		expect(feedHealth(never, '2026-09-24', 'Africa/Johannesburg')).toMatchObject({ state: 'stale', reason: { code: 'not-fetched', since: '2026-09-21', after: 'attached' } });
		// …which is within the grace on the 23rd there, and past it in UTC's reckoning.
		expect(feedHealth(never, '2026-09-23', 'Africa/Johannesburg').state).toBe('pending');
		expect(feedHealth(never, '2026-09-23', 'UTC').state).toBe('stale');
	});

	// rnl has no preliminary product: CHC publishes it a month at a time, 11–26 days after the month ends
	// (2026), so its newest day is up to ~57 days old on a normal day. sat's 12 days made it stale most of the month.
	it.each(['UTC', 'Pacific/Kiritimati'])('an rnl feed is stale only past CHIRPS_RNL_STALE_AFTER_DAYS (TZ %s)', (zone) => {
		process.env.TZ = zone;
		const rnl = { ...base, config: { ...base.config, product: 'rnl' as const }, lastDataDate: '2026-07-31' };
		// 56 days: August not out yet, as on 2026-09-10.
		expect(feedHealth(rnl, today, 'UTC')).toMatchObject({ state: 'ok', stale: false, staleAfterDays: 62 });
		expect(feedHealth({ ...rnl, lastDataDate: '2026-07-25' }, today, 'UTC')).toMatchObject({ state: 'ok', staleAfterDays: 62 });
		expect(feedHealth({ ...rnl, lastDataDate: '2026-07-24' }, today, 'UTC')).toMatchObject({ state: 'stale', reason: { code: 'old-data', newest: '2026-07-24' } });
		// Positive control: sat at the same age is stale (its preliminary files are days old).
		expect(feedHealth({ ...base, lastDataDate: '2026-07-31' }, today, 'UTC')).toMatchObject({ state: 'stale', staleAfterDays: 12 });
		// The feed's own staleAfterDays still wins.
		expect(feedHealth({ ...rnl, config: { ...rnl.config, staleAfterDays: 30 } }, today, 'UTC')).toMatchObject({ state: 'stale', staleAfterDays: 30 });
	});

	// Issue #40c: a staged replacement reads old days, so "old data" would mislead.
	it.each(['UTC', 'Pacific/Kiritimati'])('rebuilding: a staged replacement says how far it has got, and stalls after a day without growing (TZ %s)', (zone) => {
		process.env.TZ = zone;
		const backfilling = { ...base, lastDataDate: '2001-04-30', rebuilding: { startDate: '2001-01-01', through: '2001-04-30', updatedAt: '2026-09-25T00:10:00Z' } };
		expect(feedHealth(backfilling, today, 'UTC')).toEqual({ state: 'pending', stale: false, staleAfterDays: 12, reason: { code: 'rebuilding', from: '2001-01-01', through: '2001-04-30' } });
		expect(feedHealth({ ...backfilling, rebuilding: { ...backfilling.rebuilding, updatedAt: new Date('2026-09-24T00:00:00Z') } }, today, 'UTC').reason.code).toBe('rebuilding');
		expect(feedHealth({ ...backfilling, rebuilding: { ...backfilling.rebuilding, updatedAt: '2026-09-23T23:00:00Z' } }, today, 'UTC')).toEqual({
			state: 'stale',
			stale: true,
			staleAfterDays: 12,
			reason: { code: 'rebuild-stalled', from: '2001-01-01', through: '2001-04-30', since: '2026-09-23' }
		});
		// A failing fetch, or a switched-off feed, says that first.
		expect(feedHealth({ ...backfilling, consecutiveFailures: 1, lastError: 'x' }, today, 'UTC').state).toBe('failing');
		expect(feedHealth({ ...backfilling, enabled: false }, today, 'UTC').state).toBe('disabled');
	});

	it('never sends a sentence: only the state, the threshold and the reason', () => {
		expect(Object.keys(feedHealth(base, today, 'UTC')).sort()).toEqual(['reason', 'stale', 'staleAfterDays', 'state']);
	});

	it('stale: CHIRPS newer than 12 days is fine, older is stale', () => {
		expect(feedHealth({ ...base, lastDataDate: '2026-09-13' }, today, 'UTC').state).toBe('ok');
		expect(feedHealth({ ...base, lastDataDate: '2026-09-12' }, today, 'UTC')).toEqual({ state: 'stale', stale: true, staleAfterDays: 12, reason: { code: 'old-data', newest: '2026-09-12' } });
	});

	it('stale: a forecast that reaches less than 12 days ahead', () => {
		const gefs = { ...base, source: 'chirps_gefs' as const };
		expect(feedHealth({ ...gefs, lastDataDate: '2026-10-09' }, today, 'UTC').state).toBe('ok');
		expect(feedHealth({ ...gefs, lastDataDate: '2026-10-06' }, today, 'UTC')).toEqual({
			state: 'stale',
			stale: true,
			staleAfterDays: -12,
			reason: { code: 'old-forecast', newest: '2026-10-06' }
		});
	});

	it('stale: DWS allows months of lag, and a feed’s own staleAfterDays wins', () => {
		const dws = { ...base, source: 'dws' as const, config: { station: 'X0H000' } };
		expect(feedHealth({ ...dws, lastDataDate: '2026-03-01' }, today, 'UTC').state).toBe('ok');
		expect(feedHealth({ ...dws, lastDataDate: '2025-12-01' }, today, 'UTC').state).toBe('stale');
		expect(feedHealth({ ...dws, config: { station: 'X0H000', staleAfterDays: 400 }, lastDataDate: '2025-12-01' }, today, 'UTC')).toMatchObject({ state: 'ok', staleAfterDays: 400 });
	});

	it('failing wins over stale, and says both what failed and how old the data is', () => {
		const h = feedHealth({ ...base, consecutiveFailures: 3, lastError: 'the source is unreachable: HTTP 503', lastDataDate: '2026-09-01' }, today, 'UTC');
		expect(h).toEqual({
			state: 'failing',
			stale: true,
			staleAfterDays: 12,
			reason: { code: 'failing', failures: 3, error: 'the source is unreachable: HTTP 503', newest: '2026-09-01' }
		});
		expect(feedHealth({ ...base, consecutiveFailures: 1, lastError: null, lastDataDate: null }, today, 'UTC').reason).toEqual({ code: 'failing', failures: 1, error: null, newest: null });
	});

	it('pending: never fetched, just attached', () => {
		expect(feedHealth({ ...base, createdAt: '2026-09-24T10:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null }, today, 'UTC')).toEqual({
			state: 'pending',
			stale: false,
			staleAfterDays: 12,
			reason: { code: 'waiting' }
		});
	});

	it('stale: never fetched days after it was attached (is the worker running?), or fetching but finding nothing', () => {
		const never = { ...base, createdAt: '2026-09-20T10:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null };
		expect(feedHealth(never, today, 'UTC')).toMatchObject({ state: 'stale', reason: { code: 'not-fetched', since: '2026-09-20', after: 'attached' } });
		const empty = { ...never, lastAttemptAt: '2026-09-24T06:00:00Z', lastSuccessAt: '2026-09-24T06:00:00Z' };
		expect(feedHealth(empty, today, 'UTC')).toMatchObject({ state: 'stale', reason: { code: 'no-data' } });
	});

	it('pending again after a new place or series is saved: the old fetches say nothing about it', () => {
		// 018_feeds.sql clears the data, success and failures on a re-target, but keeps last_attempt_at.
		const retargeted = { ...base, updatedAt: '2026-09-25T09:00:00Z', lastSuccessAt: null, lastDataDate: null, consecutiveFailures: 0 };
		expect(feedHealth(retargeted, today, 'UTC')).toEqual({ state: 'pending', stale: false, staleAfterDays: 12, reason: { code: 'waiting' } });
		// Still unfetched two days on: the worker may not be running, counted from the save.
		expect(feedHealth(retargeted, '2026-09-28', 'UTC')).toMatchObject({ state: 'stale', reason: { code: 'not-fetched', since: '2026-09-25', after: 'changed' } });
		// Fetched since, finding nothing: ok, with no newest day.
		expect(feedHealth({ ...retargeted, lastAttemptAt: '2026-09-25T09:05:00Z', lastSuccessAt: '2026-09-25T09:05:00Z' }, today, 'UTC')).toMatchObject({
			state: 'ok',
			reason: { code: 'ok', newest: null, checked: '2026-09-25' }
		});
		// A plain save (same place and series) keeps the data, so the data decides.
		expect(feedHealth({ ...base, updatedAt: '2026-09-25T09:00:00Z' }, today, 'UTC').state).toBe('ok');
	});

	it('disabled, whatever else', () => {
		expect(feedHealth({ ...base, enabled: false, consecutiveFailures: 2 }, today, 'UTC')).toMatchObject({ state: 'disabled', reason: { code: 'off', newest: '2026-09-20' } });
		expect(feedHealth({ ...base, enabled: false, lastDataDate: null }, today, 'UTC').reason).toEqual({ code: 'off', newest: null });
	});
});

// Issue #604 Round 2: with CHIRPS read from our own copy, a late copy is not the feed's fault.
describe('rainCopyStatus', () => {
	const days = (sat: string | null, rnl: string | null, prelim: string | null): CopyDays => ({
		sat: { finalThrough: sat },
		rnl: { finalThrough: rnl },
		prelim: { prelimThrough: prelim }
	});

	it('finals are on time up to COPY_FINAL_LAG_DAYS (75) days back, and behind one day past it', () => {
		expect(COPY_FINAL_LAG_DAYS).toBe(75);
		// 2026-07-31 + 75 days = 2026-10-14.
		const at = (asOf: string) => rainCopyStatus(days('2026-07-31', '2026-07-31', '2026-10-10'), asOf);
		expect(at('2026-10-14')).toMatchObject({ readable: true, asOf: '2026-10-14', final: { sat: { through: '2026-07-31', behind: false }, rnl: { through: '2026-07-31', behind: false } } });
		expect(at('2026-10-15')).toMatchObject({ final: { sat: { behind: true }, rnl: { behind: true } } });
	});

	it('preliminary days are on time up to COPY_PRELIM_LAG_DAYS (7) back, and behind one day past it', () => {
		expect(COPY_PRELIM_LAG_DAYS).toBe(7);
		const at = (asOf: string) => rainCopyStatus(days('2026-08-31', '2026-08-31', '2026-10-07'), asOf).preliminary;
		expect(rainCopyStatus(days('2026-08-31', '2026-08-31', '2026-10-07'), '2026-10-14')).toMatchObject({ preliminary: { through: '2026-10-07', behind: false } });
		expect(at('2026-10-15')).toEqual({ through: '2026-10-07', behind: true });
	});

	it('a product the copy doesn’t hold yet is behind; a missing prelim is judged by sat’s finals', () => {
		const none = rainCopyStatus({ sat: null, rnl: null, prelim: null }, '2026-10-27');
		expect(none).toEqual({
			readable: true,
			sample: false,
			asOf: '2026-10-27',
			final: { sat: { through: null, behind: true }, rnl: { through: null, behind: true } },
			preliminary: { through: null, behind: true }
		});
		// Finals newer than the preliminary days (a month's finals just landed, its preliminary days dropped): the copy is current.
		expect(rainCopyStatus(days('2026-10-24', '2026-10-24', null), '2026-10-27').preliminary).toEqual({ through: null, behind: false });
		// Positive control: the same with old finals is behind.
		expect(rainCopyStatus(days('2026-08-31', '2026-08-31', null), '2026-10-27').preliminary.behind).toBe(true);
	});
});

describe('feedHealth with our copy', () => {
	const fresh = rainCopyStatus({ sat: { finalThrough: '2026-08-31' }, rnl: { finalThrough: '2026-08-31' }, prelim: { prelimThrough: '2026-09-22' } }, today);
	const latePrelim = rainCopyStatus({ sat: { finalThrough: '2026-08-31' }, rnl: { finalThrough: '2026-08-31' }, prelim: { prelimThrough: '2026-09-15' } }, today);
	const lateFinals = rainCopyStatus({ sat: { finalThrough: '2026-07-01' }, rnl: { finalThrough: '2026-07-01' }, prelim: { prelimThrough: '2026-09-22' } }, today);
	const rnl = { ...base, config: { ...base.config, product: 'rnl' as const }, lastDataDate: '2026-07-01' };

	it('a sat feed shows copy-behind when the preliminary days or sat’s finals are late, with the copy’s days and its own newest', () => {
		expect(feedHealth(base, today, 'UTC', fresh).state).toBe('ok');
		expect(feedHealth(base, today, 'UTC', latePrelim)).toEqual({
			state: 'copy-behind',
			stale: false,
			staleAfterDays: 12,
			reason: { code: 'copy-behind', product: 'sat', final: '2026-08-31', preliminary: '2026-09-15', newest: '2026-09-20' }
		});
		expect(feedHealth(base, today, 'UTC', lateFinals).reason).toMatchObject({ code: 'copy-behind', final: '2026-07-01', preliminary: '2026-09-22' });
		// Instead of "no new data": the copy, not the feed, is late.
		expect(feedHealth({ ...base, lastDataDate: '2026-09-01' }, today, 'UTC', latePrelim)).toMatchObject({ state: 'copy-behind', stale: true });
	});

	it('an rnl feed reads rnl’s finals only: late preliminary days don’t touch it', () => {
		expect(feedHealth({ ...rnl, lastDataDate: '2026-08-31' }, today, 'UTC', latePrelim).state).toBe('ok');
		expect(feedHealth(rnl, today, 'UTC', lateFinals).reason).toEqual({ code: 'copy-behind', product: 'rnl', final: '2026-07-01', preliminary: null, newest: '2026-07-01' });
	});

	it('the feed’s own state wins: off, failing, rebuilding and never fetched stay as they are', () => {
		expect(feedHealth({ ...base, enabled: false }, today, 'UTC', latePrelim).state).toBe('disabled');
		expect(feedHealth({ ...base, consecutiveFailures: 1, lastError: 'x' }, today, 'UTC', latePrelim).state).toBe('failing');
		expect(feedHealth({ ...base, rebuilding: { startDate: '2001-01-01', through: '2001-04-30', updatedAt: '2026-09-25T00:10:00Z' } }, today, 'UTC', latePrelim).state).toBe('pending');
		const waiting = { ...base, createdAt: '2026-09-24T10:00:00Z', lastAttemptAt: null, lastSuccessAt: null, lastDataDate: null };
		expect(feedHealth(waiting, today, 'UTC', latePrelim).reason).toEqual({ code: 'waiting' });
	});

	it('only CHIRPS reads the copy, and no copy (CHC read directly) or an unreadable one changes nothing', () => {
		const gefs = { ...base, source: 'chirps_gefs' as const, lastDataDate: '2026-10-09' };
		expect(feedHealth(gefs, today, 'UTC', latePrelim).state).toBe('ok');
		expect(feedHealth(base, today, 'UTC', null).state).toBe('ok');
		expect(feedHealth(base, today, 'UTC', { readable: false }).state).toBe('ok');
		expect(copyBehind({ ...base, source: 'dws', config: { station: 'X0H000' } }, lateFinals)).toBeNull();
	});
});
