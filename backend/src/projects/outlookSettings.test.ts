import { DEFAULT_OUTLOOK_SEASON } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { OUTLOOK_DEFAULTS, outlookSeasonFor, resolveOutlook, reviewDateFor, seasonError } from './outlookSettings.js';
import { patchSettings, SettingsPatch } from './settings.js';

const ok = (outlook: unknown) => SettingsPatch.safeParse({ outlook }).success;
const summer = { startMonth: 11, startDay: 15, endMonth: 3, endDay: 31 };

describe('SettingsPatch.outlook', () => {
	it('accepts either field, the defaults (null), a season across the new year or within one, and shares in (0, 1]', () => {
		expect(ok({})).toBe(true);
		expect(ok({ season: null, planningShare: null })).toBe(true);
		expect(ok({ season: summer })).toBe(true);
		expect(ok({ season: { startMonth: 9, startDay: 1, endMonth: 12, endDay: 31 } })).toBe(true);
		expect(ok({ season: { startMonth: 2, startDay: 28, endMonth: 2, endDay: 27 } })).toBe(true);
		for (const s of [0.5, 0.8, 1, 0.001]) expect(ok({ planningShare: s }), String(s)).toBe(true);
	});

	it('rejects a day that is not one (29 February too), a one-day season, a share outside (0, 1], half a season and unknown keys', () => {
		for (const bad of [
			{ season: { ...summer, startDay: 31, startMonth: 11 } },
			{ season: { ...summer, endMonth: 2, endDay: 29 } },
			{ season: { ...summer, startMonth: 13 } },
			{ season: { ...summer, startMonth: 0 } },
			{ season: { ...summer, startDay: 1.5 } },
			{ season: { startMonth: 10, startDay: 1, endMonth: 10, endDay: 1 } },
			{ season: { startMonth: 10, startDay: 1 } },
			{ season: { ...summer, extra: 1 } },
			{ planningShare: 0 },
			{ planningShare: 1.01 },
			{ planningShare: -0.2 },
			{ planningShare: Number.NaN },
			{ planningShare: '0.8' },
			{ share: 0.8 },
			null
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it('says why in words', () => {
		expect(seasonError({ startMonth: 2, startDay: 29, endMonth: 4, endDay: 30 })).toMatch(/29 February/);
		expect(seasonError({ startMonth: 10, startDay: 1, endMonth: 10, endDay: 1 })).toMatch(/at least two days/);
		const r = SettingsPatch.safeParse({ outlook: { planningShare: 0 } });
		expect(r.error!.issues[0]!.message).toBe('the planning share must be more than 0');
	});
});

describe('resolveOutlook', () => {
	it('fills the defaults (null: the engine’s, confirmed by the client) and falls back field by field', () => {
		expect(resolveOutlook({})).toEqual(OUTLOOK_DEFAULTS);
		expect(resolveOutlook(null)).toEqual({ season: null, planningShare: null, review: null });
		expect(resolveOutlook({ outlook: 'x' })).toEqual(OUTLOOK_DEFAULTS);
		expect(resolveOutlook({ outlook: { season: summer, planningShare: 0.7 } })).toEqual({ season: summer, planningShare: 0.7, review: null });
		expect(resolveOutlook({ outlook: { season: { ...summer, endDay: 32 }, planningShare: 0.7 } })).toEqual({ season: null, planningShare: 0.7, review: null });
		expect(resolveOutlook({ outlook: { season: summer, planningShare: 2 } })).toEqual({ season: summer, planningShare: null, review: null });
	});
});

describe('patchSettings with outlook', () => {
	it('merges one level deep: the share alone keeps a stored season, and a season is replaced whole', () => {
		const stored = { outlook: { season: summer, planningShare: 0.9 } };
		expect((patchSettings(stored, { outlook: { planningShare: 0.7 } }) as unknown as { outlook: unknown }).outlook).toEqual({ season: summer, planningShare: 0.7 });
		expect((patchSettings(stored, { outlook: { season: null } }) as unknown as { outlook: unknown }).outlook).toEqual({ season: null, planningShare: 0.9 });
	});
});

describe('outlookSeasonFor', () => {
	it('the default season (1 October – 30 April) from the run’s newest state: the latest decision date whose day before the run holds', () => {
		expect(DEFAULT_OUTLOOK_SEASON).toMatchObject({ startMonth: 10, startDay: 1, endMonth: 4, endDay: 30 });
		// A run to 30 September: the season starts the next day, from the run's last state.
		expect(outlookSeasonFor(null, '2000-10-01', '2012-09-30')).toEqual({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30' });
		// A run to 29 September can't reach 1 October 2012's state: the one before it.
		expect(outlookSeasonFor(null, '2000-10-01', '2012-09-29')).toEqual({ decisionDate: '2011-10-01', seasonEnd: '2012-04-30' });
		expect(outlookSeasonFor(null, '2000-10-01', '2013-02-10')).toEqual({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30' });
	});

	it('a season inside one calendar year, a season across the new year, and a run too short to hold a decision date', () => {
		const autumn = { startMonth: 3, startDay: 1, endMonth: 8, endDay: 31 };
		expect(outlookSeasonFor(autumn, '2000-01-01', '2010-12-31')).toEqual({ decisionDate: '2010-03-01', seasonEnd: '2010-08-31' });
		expect(outlookSeasonFor(summer, '2000-01-01', '2010-11-14')).toEqual({ decisionDate: '2010-11-15', seasonEnd: '2011-03-31' });
		expect(outlookSeasonFor(summer, '2000-01-01', '2010-11-13')).toEqual({ decisionDate: '2009-11-15', seasonEnd: '2010-03-31' });
		// The decision date must come after the run's first day (there is a state to start from).
		expect(outlookSeasonFor(null, '2012-10-01', '2013-02-01')).toBeNull();
		expect(outlookSeasonFor(null, '2012-09-30', '2013-02-01')).toEqual({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30' });
	});
});

describe('settings.outlook.review (issue #53 R6)', () => {
	it('accepts a month and day or null, refuses 29 February, a day that is not one and unknown keys; resolves a bad stored one to the default', () => {
		expect(ok({ review: { month: 1, day: 1 } })).toBe(true);
		expect(ok({ review: null })).toBe(true);
		for (const bad of [{ month: 2, day: 29 }, { month: 4, day: 31 }, { month: 13, day: 1 }, { month: 1 }, { month: 1, day: 1, year: 2020 }]) expect(ok({ review: bad }), JSON.stringify(bad)).toBe(false);
		expect(resolveOutlook({ outlook: { review: { month: 2, day: 1 } } }).review).toEqual({ month: 2, day: 1 });
		expect(resolveOutlook({ outlook: { review: { month: 2, day: 30 } } }).review).toBeNull();
	});

	it('reviewDateFor: the default is the engine’s (1 January for the default season); a setting is the first such day after the decision date, inside the season', () => {
		const season = { decisionDate: '2013-10-01', seasonEnd: '2014-04-30' };
		expect(reviewDateFor(null, season)).toEqual({ date: '2014-01-01' });
		expect(reviewDateFor({ month: 12, day: 15 }, season)).toEqual({ date: '2013-12-15' });
		expect(reviewDateFor({ month: 4, day: 30 }, season)).toEqual({ date: '2014-04-30' });
		// On the decision date itself: next year's, outside the season.
		expect(reviewDateFor({ month: 10, day: 1 }, season)).toMatchObject({ error: expect.stringMatching(/not inside the season/) });
		expect(reviewDateFor({ month: 7, day: 1 }, season)).toMatchObject({ error: expect.stringMatching(/not inside the season/) });
		// A season within one calendar year.
		expect(reviewDateFor({ month: 3, day: 1 }, { decisionDate: '2014-01-15', seasonEnd: '2014-06-30' })).toEqual({ date: '2014-03-01' });
	});
});
