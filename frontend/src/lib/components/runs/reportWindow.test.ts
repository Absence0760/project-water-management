import { afterEach, describe, expect, it } from 'vitest';
import { describePeriod, forecastDaysIn, isIsoDate, parseWindowParam, presetLabel, resolveWindow, sameWindow, windowParam, WINDOW_PRESETS, type WindowChoice } from './reportWindow';

const run = { startDate: '2021-10-01', endDate: '2022-01-28' };
const own = { reportStart: '2021-11-01', reportEnd: '2021-12-31' };

describe('the ?window= parameter', () => {
	it('round-trips every preset and a custom range; the run’s own window is no parameter at all', () => {
		const choices: WindowChoice[] = [{ preset: 'last7' }, { preset: 'last14' }, { preset: 'last30' }, { preset: 'all' }, { preset: 'custom', start: '2021-12-01', end: '2021-12-31' }];
		for (const c of choices) expect(parseWindowParam(windowParam(c))).toEqual(c);
		expect(windowParam({ preset: 'project' })).toBeNull();
		expect(windowParam({ preset: 'custom', start: '2021-12-01', end: '2021-12-31' })).toBe('2021-12-01..2021-12-31');
	});

	it('reads anything it does not know as the run’s own window', () => {
		for (const v of [null, undefined, '', 'last8', 'week', '2021-12-01', '2021-02-30..2021-03-01', '2021-12-01..2021-13-01', '2021-12-01...2021-12-02']) {
			expect(parseWindowParam(v), String(v)).toEqual({ preset: 'project' });
		}
		expect(parseWindowParam('project')).toEqual({ preset: 'project' });
	});

	it('accepts only real calendar dates', () => {
		expect(isIsoDate('2024-02-29')).toBe(true);
		expect(isIsoDate('2023-02-29')).toBe(false);
		expect(isIsoDate('2023-2-01')).toBe(false);
		expect(isIsoDate('nope')).toBe(false);
	});
});

describe('resolveWindow', () => {
	const ok = (c: WindowChoice, r = run) => {
		const res = resolveWindow(c, r, own);
		if (!res.ok) throw new Error(res.error);
		return res;
	};

	it('gives the run’s own window, the whole record, and the last N days to the run’s last day', () => {
		expect(ok({ preset: 'project' }).window).toEqual({ from: 31, to: 91, reportStart: '2021-11-01', reportEnd: '2021-12-31', days: 61 });
		expect(ok({ preset: 'all' }).window).toEqual({ from: 0, to: 119, reportStart: '2021-10-01', reportEnd: '2022-01-28', days: 120 });
		expect(ok({ preset: 'last7' }).window).toMatchObject({ from: 113, to: 119, reportStart: '2022-01-22', reportEnd: '2022-01-28', days: 7 });
		expect(ok({ preset: 'last14' }).window).toMatchObject({ reportStart: '2022-01-15', days: 14 });
		expect(ok({ preset: 'last30' }).window).toMatchObject({ reportStart: '2021-12-30', days: 30 });
		expect(ok({ preset: 'last30' }).note).toBeNull();
	});

	it('says so when the run is shorter than the preset', () => {
		const short = ok({ preset: 'last30' }, { startDate: '2022-01-20', endDate: '2022-01-28' });
		expect(short.window).toMatchObject({ from: 0, to: 8, days: 9 });
		expect(short.note).toBe('The run has only 9 days, so this covers all of it.');
	});

	it('cuts a custom range to the run, and refuses one that is backwards or misses the run', () => {
		expect(ok({ preset: 'custom', start: '2021-12-01', end: '2021-12-07' })).toEqual({
			ok: true,
			window: { from: 61, to: 67, reportStart: '2021-12-01', reportEnd: '2021-12-07', days: 7 },
			note: null
		});
		const cut = ok({ preset: 'custom', start: '2021-01-01', end: '2022-06-30' });
		expect(cut.window).toMatchObject({ reportStart: '2021-10-01', reportEnd: '2022-01-28', days: 120 });
		expect(cut.note).toBe('Cut to the run: 2021-10-01 to 2022-01-28.');
		expect(resolveWindow({ preset: 'custom', start: '2021-12-07', end: '2021-12-01' }, run, own)).toEqual({ ok: false, error: 'The window must start before it ends.' });
		expect(resolveWindow({ preset: 'custom', start: '2022-02-01', end: '2022-02-07' }, run, own)).toEqual({
			ok: false,
			error: 'The window 2022-02-01 to 2022-02-07 is outside this run (2021-10-01 to 2022-01-28).'
		});
		// One day is a window.
		expect(ok({ preset: 'custom', start: '2022-01-28', end: '2022-01-28' }).window.days).toBe(1);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('never moves a day, east or west of UTC, across a leap day', () => {
			const leap = { startDate: '2024-02-01', endDate: '2024-03-03' };
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(ok({ preset: 'last7' }, leap).window, zone).toMatchObject({ reportStart: '2024-02-26', reportEnd: '2024-03-03', from: 25, to: 31, days: 7 });
				expect(ok({ preset: 'last7' }).window.reportStart, zone).toBe('2022-01-22');
			}
		});
	});
});

describe('labels', () => {
	it('names each preset and the period a figure covers', () => {
		expect(WINDOW_PRESETS.map((p) => p.label)).toEqual(['Project window', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Whole record', 'Custom range']);
		expect(presetLabel('last14')).toBe('Last 14 days');
		expect(describePeriod({ reportStart: '2022-01-22', reportEnd: '2022-01-28', days: 7 })).toBe('2022-01-22 to 2022-01-28 (7 days)');
		expect(describePeriod({ reportStart: '2022-01-28', reportEnd: '2022-01-28', days: 1 })).toBe('2022-01-28 to 2022-01-28 (1 day)');
		expect(sameWindow(own, { ...own })).toBe(true);
		expect(sameWindow(own, { ...own, reportEnd: '2022-01-01' })).toBe(false);
	});

	it('counts the window’s days in the forecast period', () => {
		const w = { reportStart: '2022-01-22', reportEnd: '2022-01-28' };
		expect(forecastDaysIn(w, { days: 5, from: '2022-01-24', to: '2022-01-28', inReport: 0, lastRecorded: '2022-01-23' })).toBe(5);
		expect(forecastDaysIn(w, { days: 10, from: '2022-01-25', to: '2022-02-03', inReport: 0, lastRecorded: null })).toBe(4);
		expect(forecastDaysIn(w, { days: 3, from: '2022-02-01', to: '2022-02-03', inReport: 0, lastRecorded: null })).toBe(0);
		expect(forecastDaysIn(w, null)).toBe(0);
		expect(forecastDaysIn(w, undefined)).toBe(0);
	});
});
