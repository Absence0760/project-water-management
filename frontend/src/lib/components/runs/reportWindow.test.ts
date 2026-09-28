import { afterEach, describe, expect, it } from 'vitest';
import { describePeriod, forecastDaysIn, isIsoDate, parseWindowParam, presetLabel, resolveWindow, runDataUntil, sameWindow, windowParam, WINDOW_PRESETS, type WindowChoice } from './reportWindow';

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
	const ok = (c: WindowChoice, r: Parameters<typeof resolveWindow>[1] = run) => {
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

	it('ends the last N days on the day before a forecast run’s forecast, and says so (issue #51)', () => {
		// The run's last 14 days (2022-01-15 … 01-28) are forecast days.
		const forecast = { ...run, forecastFrom: '2022-01-15' };
		const w = ok({ preset: 'last7' }, forecast);
		expect(w.window).toMatchObject({ from: 99, to: 105, reportStart: '2022-01-08', reportEnd: '2022-01-14', days: 7 });
		expect(w.note).toBe('It ends on 2022-01-14, the last day before the forecast.');
		// The whole record and a custom range end there too: a historical figure never averages over forecast days.
		const all = ok({ preset: 'all' }, forecast);
		expect(all.window).toMatchObject({ reportStart: '2021-10-01', reportEnd: '2022-01-14', days: 106 });
		expect(all.note).toBe('It ends on 2022-01-14, the last day before the forecast.');
		const custom = ok({ preset: 'custom', start: '2022-01-01', end: '2022-01-20' }, forecast);
		expect(custom.window).toMatchObject({ reportStart: '2022-01-01', reportEnd: '2022-01-14', days: 14 });
		expect(custom.note).toBe('Cut to the record before the forecast: 2022-01-01 to 2022-01-14.');
		expect(resolveWindow({ preset: 'custom', start: '2022-01-16', end: '2022-01-20' }, forecast, own)).toEqual({
			ok: false,
			error: "The window 2022-01-16 to 2022-01-20 is in the forecast: this run's record ends on 2022-01-14."
		});
		// A range inside the record is untouched; one past the run's end is cut to the record, which comes first.
		expect(ok({ preset: 'custom', start: '2022-01-01', end: '2022-01-10' }, forecast).note).toBeNull();
		expect(ok({ preset: 'custom', start: '2022-01-01', end: '2022-03-01' }, forecast).note).toBe('Cut to the record before the forecast: 2022-01-01 to 2022-01-14.');
		// Positive controls: an ordinary run's whole record and a custom range reach its last day.
		expect(ok({ preset: 'all' }, { ...run, forecastFrom: null })).toMatchObject({ window: { reportEnd: '2022-01-28' }, note: null });
		expect(ok({ preset: 'custom', start: '2022-01-01', end: '2022-03-01' }).note).toBe('Cut to the run: 2022-01-01 to 2022-01-28.');
		// Positive control: an ordinary run's last 7 days end on its last day.
		expect(ok({ preset: 'last7' }, { ...run, forecastFrom: null }).window.reportEnd).toBe('2022-01-28');
	});

	it('says so when the run is shorter than the preset', () => {
		const short = ok({ preset: 'last30' }, { startDate: '2022-01-20', endDate: '2022-01-28' });
		expect(short.window).toMatchObject({ from: 0, to: 8, days: 9 });
		expect(short.note).toBe('The run has only 9 days of recorded rain, so this covers all of it.');
	});

	it('ends the last N days on the last day of recorded rain, as the publication counts them (positive control: rain to the run’s end)', () => {
		const rainTo = (length: number) => ({ ...run, inputSeries: { rain_catchment_mm: { startDate: '2021-10-01', length }, flow_observed_m3s: { startDate: '2021-10-01', length: 200 } } });
		// Rain ends 2022-01-26, two days before the run: the week is the 7 days to the 26th, and says why.
		const gap = ok({ preset: 'last7' }, rainTo(118));
		expect(gap.window).toMatchObject({ reportStart: '2022-01-20', reportEnd: '2022-01-26', from: 111, to: 117, days: 7 });
		expect(gap.note).toBe('Ends on the last day of recorded rain, 2022-01-26; the run goes on to 2022-01-28 without it.');
		expect(ok({ preset: 'last7' }, rainTo(120))).toMatchObject({ window: { reportEnd: '2022-01-28' }, note: null });
		// A forecast run: the day before its first forecast day; clamped to the run.
		expect(runDataUntil({ ...run, summary: { forecast: { from: '2022-01-20' } } })).toBe('2022-01-19');
		expect(runDataUntil({ ...run, inputSeries: { rain_chirps_mm: { startDate: '2022-06-01', length: 5 } } })).toBe('2022-01-28');
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
