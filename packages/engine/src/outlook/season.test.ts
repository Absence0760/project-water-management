// The outlook's calendar (docs/model.md §2.15): the default season, season
// checks, and which stretch of the record each analogue year supplies.
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import { analogueStart, defaultOutlookSeason, outlookAnalogue, resolveSeason, seasonWaterYear } from './season';

describe('defaultOutlookSeason (O3, confirmed by the client)', () => {
	it('is the next 1 October to 30 April, on or after the day asked', () => {
		expect(defaultOutlookSeason('2026-09-26')).toEqual({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
		expect(defaultOutlookSeason('2026-10-01')).toEqual({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
		expect(defaultOutlookSeason('2026-10-02')).toEqual({ decisionDate: '2027-10-01', seasonEnd: '2028-04-30' });
		expect(defaultOutlookSeason('2027-01-15')).toEqual({ decisionDate: '2027-10-01', seasonEnd: '2028-04-30' });
	});
});

describe('resolveSeason', () => {
	it('counts the days, inclusive', () => {
		expect(resolveSeason({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' })).toMatchObject({ days: 212, from: toEpochDay('2026-10-01'), to: toEpochDay('2027-04-30') });
		expect(resolveSeason({ decisionDate: '2026-10-01', seasonEnd: '2026-10-01' }).days).toBe(1);
	});

	it('refuses a date that is not one, an end before the start and a season over a year', () => {
		expect(() => resolveSeason({ decisionDate: '2026-02-30', seasonEnd: '2026-04-30' })).toThrow(/not an ISO date/);
		expect(() => resolveSeason({ decisionDate: '1 Oct', seasonEnd: '2026-04-30' })).toThrow(/not an ISO date/);
		expect(() => resolveSeason({ decisionDate: '2026-10-01', seasonEnd: '2026-09-30' })).toThrow(/before its decision date/);
		expect(() => resolveSeason({ decisionDate: '2026-10-01', seasonEnd: '2027-10-02' })).toThrow(/at most 366/);
		expect(resolveSeason({ decisionDate: '2027-10-01', seasonEnd: '2028-09-30' }).days).toBe(366);
	});
});

describe('analogue day mapping', () => {
	it('puts analogue W on the decision date’s month and day in W', () => {
		const s = resolveSeason({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
		expect(outlookAnalogue(s, 2003)).toEqual({ waterYear: 2003, label: '2003/04', from: '2003-10-01', to: '2004-04-29' });
		expect(outlookAnalogue(s, 2004)).toEqual({ waterYear: 2004, label: '2004/05', from: '2004-10-01', to: '2005-04-30' });
		// The season's own water year is the season.
		expect(outlookAnalogue(s, seasonWaterYear(s))).toMatchObject({ from: '2026-10-01', to: '2027-04-30' });
	});

	it('draws a season that crosses 1 October from two water years in order, labelled by its first day', () => {
		const s = resolveSeason({ decisionDate: '2026-09-01', seasonEnd: '2027-03-31' });
		expect(seasonWaterYear(s)).toBe(2025);
		const a = outlookAnalogue(s, 2009);
		expect(a).toEqual({ waterYear: 2009, label: '2009/10', from: '2010-09-01', to: '2011-03-31' });
		expect(waterYearOf(toEpochDay(a.from))).toBe(2009);
		expect(waterYearOf(toEpochDay(a.to))).toBe(2010);
		// Over a leap February the analogue's calendar ends a day earlier.
		expect(outlookAnalogue(s, 2010)).toMatchObject({ from: '2011-09-01', to: '2012-03-30' });
		expect(outlookAnalogue(s, 2025)).toMatchObject({ from: '2026-09-01', to: '2027-03-31' });
	});

	it('maps a 29 February decision date to 28 February in a common year, and back to 29 February in a leap year', () => {
		expect(analogueStart('2024-02-29', 2022)).toBe(toEpochDay('2023-02-28'));
		expect(analogueStart('2024-02-29', 2019)).toBe(toEpochDay('2020-02-29'));
		expect(analogueStart('2023-02-28', 2019)).toBe(toEpochDay('2020-02-28'));
		// A season over February keeps its length: a leap analogue ends a day earlier in the calendar.
		const s = resolveSeason({ decisionDate: '2023-02-01', seasonEnd: '2023-03-31' });
		expect(outlookAnalogue(s, 2019)).toMatchObject({ from: '2020-02-01', to: '2020-03-30' });
		expect(outlookAnalogue(s, 2020)).toMatchObject({ from: '2021-02-01', to: '2021-03-31' });
	});

	it('gives the same days under a skewed TZ', () => {
		const tz = process.env.TZ;
		const s = resolveSeason({ decisionDate: '2024-02-29', seasonEnd: '2024-09-30' });
		const utc = [2000, 2001, 2003, 2010].map((w) => outlookAnalogue(s, w));
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect([2000, 2001, 2003, 2010].map((w) => outlookAnalogue(resolveSeason(s), w))).toEqual(utc);
				expect(defaultOutlookSeason('2026-10-01')).toEqual({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
			}
		} finally {
			process.env.TZ = tz;
		}
		expect(utc[0]).toMatchObject({ from: '2001-02-28', to: '2001-09-30' });
	});
});
